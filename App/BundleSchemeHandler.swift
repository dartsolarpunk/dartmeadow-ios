import Foundation
import WebKit
import UniformTypeIdentifiers

/// Serves the bundled game (App bundle → Web/) at `dartmeadow://localhost/…`.
///
/// * Same-origin for every game file, so ES modules, import maps, fetch(),
///   GLTFLoader, Web Audio decoding and canvas readbacks all behave exactly as
///   on https://dartmeadow.space.
/// * HTTP Range support (206) so <video>/<audio> (splash plate, soundtrack)
///   stream and seek.
/// * Live paths (static/admin/ notes) are fetched from dartmeadow.space first
///   so administration notices stay current, with the bundled copy offline.
/// * A file the bundle doesn't have (e.g. a soundtrack added on the web after
///   this build) is fetched from dartmeadow.space instead of failing.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "dartmeadow"
    static let host = "localhost"
    static var startURL: URL { URL(string: "\(scheme)://\(host)/index.html")! }

    private let root: URL
    private let remoteBase = URL(string: "https://dartmeadow.space/")!
    private let livePrefixes = ["static/admin/"]
    private let io = DispatchQueue(label: "space.dartmeadow.scheme.io", qos: .userInitiated, attributes: .concurrent)
    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 20
        return URLSession(configuration: c)
    }()

    /// Tasks WebKit still wants answers for (touch only on the main thread).
    private var live = Set<ObjectIdentifier>()
    private var remoteTasks = [ObjectIdentifier: URLSessionDataTask]()

    override init() {
        root = Bundle.main.resourceURL!.appendingPathComponent("Web", isDirectory: true)
        super.init()
    }

    // MARK: WKURLSchemeHandler

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        live.insert(id)
        guard let url = task.request.url else { return fail(task, 400) }

        var rel = url.path.removingPercentEncoding ?? url.path
        if rel.isEmpty || rel == "/" { rel = "/index.html" }
        if rel.hasSuffix("/") { rel += "index.html" }
        rel.removeFirst()
        if rel.split(separator: "/").contains("..") { return fail(task, 403) }

        let file = root.appendingPathComponent(rel)
        let exists = FileManager.default.fileExists(atPath: file.path)
        let range = task.request.value(forHTTPHeaderField: "Range")

        if livePrefixes.contains(where: { rel.hasPrefix($0) }) {
            remote(task, rel: rel, query: url.query, fallback: exists ? file : nil)
        } else if exists {
            serveFile(task, file: file, range: range)
        } else {
            remote(task, rel: rel, query: url.query, fallback: nil)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        live.remove(id)
        remoteTasks.removeValue(forKey: id)?.cancel()
    }

    // MARK: Local files

    private func serveFile(_ task: WKURLSchemeTask, file: URL, range: String?) {
        let id = ObjectIdentifier(task)
        io.async { [weak self] in
            guard let self else { return }
            guard let data = try? Data(contentsOf: file, options: .alwaysMapped) else {
                return DispatchQueue.main.async { self.fail(task, 500) }
            }
            let total = data.count
            var status = 200
            var slice = 0..<total
            var headers = self.baseHeaders(for: file.pathExtension)
            headers["Accept-Ranges"] = "bytes"
            if let range, let r = Self.parseRange(range, total: total) {
                status = 206
                slice = r
                headers["Content-Range"] = "bytes \(r.lowerBound)-\(r.upperBound - 1)/\(total)"
            } else if range != nil {
                headers["Content-Range"] = "bytes */\(total)"
                return DispatchQueue.main.async { self.respond(task, id: id, status: 416, headers: headers, body: Data()) }
            }
            headers["Content-Length"] = String(slice.count)
            DispatchQueue.main.async { self.respond(task, id: id, status: status, headers: headers, body: data, slice: slice) }
        }
    }

    private func respond(_ task: WKURLSchemeTask, id: ObjectIdentifier, status: Int, headers: [String: String],
                         body: Data, slice: Range<Int>? = nil) {
        let slice = slice ?? 0..<body.count
        guard live.contains(id), let url = task.request.url,
              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)
        else { return }
        task.didReceive(response)
        // hand big files over in pieces so WebKit can start parsing early
        let chunk = 1 << 20
        var offset = slice.lowerBound
        while offset < slice.upperBound {
            guard live.contains(id) else { return }
            let end = min(offset + chunk, slice.upperBound)
            task.didReceive(body.subdata(in: offset..<end))
            offset = end
        }
        guard live.contains(id) else { return }
        task.didFinish()
        live.remove(id)
    }

    private func fail(_ task: WKURLSchemeTask, _ status: Int) {
        let id = ObjectIdentifier(task)
        var h = baseHeaders(for: "txt")
        h["Content-Length"] = "0"
        respond(task, id: id, status: status, headers: h, body: Data())
    }

    // MARK: Remote (dartmeadow.space) passthrough

    private func remote(_ task: WKURLSchemeTask, rel: String, query: String?, fallback: URL?) {
        let id = ObjectIdentifier(task)
        var comps = URLComponents(url: remoteBase.appendingPathComponent(rel), resolvingAgainstBaseURL: false)!
        comps.percentEncodedQuery = query
        guard let url = comps.url else { return fail(task, 400) }
        var req = URLRequest(url: url)
        req.httpMethod = task.request.httpMethod ?? "GET"
        if let r = task.request.value(forHTTPHeaderField: "Range") { req.setValue(r, forHTTPHeaderField: "Range") }
        let range = task.request.value(forHTTPHeaderField: "Range")
        let dt = session.dataTask(with: req) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self, self.live.contains(id) else { return }
                self.remoteTasks.removeValue(forKey: id)
                if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), let data {
                    var headers = self.baseHeaders(for: (rel as NSString).pathExtension)
                    if let ct = http.value(forHTTPHeaderField: "Content-Type") { headers["Content-Type"] = ct }
                    if let cr = http.value(forHTTPHeaderField: "Content-Range") { headers["Content-Range"] = cr }
                    headers["Content-Length"] = String(data.count)
                    self.respond(task, id: id, status: http.statusCode, headers: headers, body: data)
                } else if let fallback {
                    self.serveFile(task, file: fallback, range: range)
                } else {
                    NSLog("[scheme] 404 %@ (%@)", rel, error?.localizedDescription ?? "not in bundle or on dartmeadow.space")
                    self.fail(task, (response as? HTTPURLResponse)?.statusCode ?? 404)
                }
            }
        }
        remoteTasks[id] = dt
        dt.resume()
    }

    // MARK: Helpers

    private func baseHeaders(for ext: String) -> [String: String] {
        [
            "Content-Type": Self.mime(for: ext),
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
            "Cross-Origin-Resource-Policy": "cross-origin",
        ]
    }

    static func parseRange(_ header: String, total: Int) -> Range<Int>? {
        guard total > 0, header.hasPrefix("bytes=") else { return nil }
        let spec = header.dropFirst(6).split(separator: ",").first.map(String.init) ?? ""
        let parts = spec.split(separator: "-", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 2 else { return nil }
        if parts[0].isEmpty, let suffix = Int(parts[1]), suffix > 0 {
            return max(0, total - suffix)..<total
        }
        guard let start = Int(parts[0]), start < total else { return nil }
        let end = parts[1].isEmpty ? total - 1 : min(Int(parts[1]) ?? (total - 1), total - 1)
        guard end >= start else { return nil }
        return start..<(end + 1)
    }

    static func mime(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "geojson": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json"
        case "md", "txt": return "text/plain; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "ico": return "image/x-icon"
        case "glb": return "model/gltf-binary"
        case "gltf": return "model/gltf+json"
        case "bin": return "application/octet-stream"
        case "ktx2": return "image/ktx2"
        case "wasm": return "application/wasm"
        case "mp4", "m4v": return "video/mp4"
        case "webm": return "video/webm"
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        case "wav": return "audio/wav"
        case "ogg": return "audio/ogg"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        default:
            return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
