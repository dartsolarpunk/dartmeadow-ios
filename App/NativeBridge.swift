import UIKit
import WebKit
import AuthenticationServices

/// JS ⇄ native bridge. The page calls
///     window.webkit.messageHandlers.dmNative.postMessage({cmd: '…', …})
/// which returns a Promise (WKScriptMessageHandlerWithReply). The friendly
/// wrapper lives in dm-ios-bridge.js as `window.DMNative.call(cmd, args)`.
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var host: GameViewController?
    let apple = AppleSignInService()
    let logger = JSConsoleLogger()

    init(host: GameViewController) {
        self.host = host
        super.init()
        NotificationCenter.default.addObserver(forName: ASAuthorizationAppleIDProvider.credentialRevokedNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            self?.host?.evaluate("window.dispatchEvent(new CustomEvent('dmnative:appleRevoked'))")
        }
        Task { @MainActor [weak self] in
            StoreService.shared.onChange = { status in
                guard let data = try? JSONSerialization.data(withJSONObject: status),
                      let json = String(data: data, encoding: .utf8) else { return }
                self?.host?.evaluate("window.dispatchEvent(new CustomEvent('dmnative:iap',{detail:\(json)}))")
            }
            StoreService.shared.start()
        }
    }

    /// Injected at document start, before any game script runs.
    static func bootScript() -> String {
        let info: [String: Any] = [
            "isApp": true,
            "platform": "ios",
            "version": AppInfo.version,
            "build": AppInfo.build,
            "web": AppInfo.webVersion,
            "device": UIDevice.current.model,
            "os": UIDevice.current.systemVersion,
            "appleSignIn": true,
        ]
        let json = (try? JSONSerialization.data(withJSONObject: info)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return """
        (function(){
          window.DM_IOS_APP = \(json);
          // Already a full-screen app: no "Add to Home Screen" tip.
          try { sessionStorage.setItem('dm_a2hs_hint', '1'); } catch (e) {}
          // Forward console + uncaught errors to the device log (Xcode / Console.app / CI smoke test).
          var post = function(level, args){
            try {
              var s = Array.prototype.map.call(args, function(a){
                if (a instanceof Error) return a.name + ': ' + a.message + (a.stack ? '\\n' + a.stack : '');
                if (typeof a === 'object') { try { return JSON.stringify(a); } catch(e) { return String(a); } }
                return String(a);
              }).join(' ');
              window.webkit.messageHandlers.dmLog.postMessage({level: level, msg: s.slice(0, 4000)});
            } catch(e) {}
          };
          ['log','info','warn','error'].forEach(function(k){
            var orig = console[k] && console[k].bind(console);
            console[k] = function(){ post(k, arguments); if (orig) orig.apply(null, arguments); };
          });
          document.addEventListener('DOMContentLoaded', function(){
            post('info', ['[dm-ios] boot', 'secureContext=' + window.isSecureContext, 'webgpu=' + !!navigator.gpu,
                          'origin=' + location.origin, 'ua=' + navigator.userAgent]);
          });
          window.addEventListener('error', function(e){ post('error', ['[uncaught] ' + (e.message || e) + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')]); });
          window.addEventListener('unhandledrejection', function(e){ var r = e.reason; post('error', ['[unhandled rejection] ' + (r && (r.stack || r.message) || r)]); });
        })();
        """
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            return replyHandler(nil, "bad bridge message")
        }
        switch cmd {
        case "appInfo":
            replyHandler(["version": AppInfo.version, "build": AppInfo.build, "web": AppInfo.webVersion], nil)

        case "appleSignIn":
            apple.signIn(anchor: host?.view.window) { result in
                switch result {
                case .success(let payload): replyHandler(payload, nil)
                case .failure(let err): replyHandler(nil, err.message)
                }
            }

        case "appleState":
            apple.credentialState { state, user in
                var out: [String: Any] = ["state": state]
                if let user { out["user"] = user }
                replyHandler(out, nil)
            }

        case "deleteAccount":
            // From the web's DMSafety.deleteAccount() (ui/dm-safety.js). Reply value = done,
            // error string = shown to the player with the Settings fallback.
            let user = body["user"] as? String
            apple.revoke(user: user) { [apple] err in
                apple.forgetAll(user: user)
                if let err { replyHandler(nil, err) } else { replyHandler(["revoked": true], nil) }
            }

        case "appleSignOut":
            apple.forget()
            replyHandler(true, nil)

        case "openExternal":
            guard let s = body["url"] as? String, let url = URL(string: s) else { return replyHandler(nil, "bad url") }
            host?.openExternal(url)
            replyHandler(true, nil)

        case "closeExternal":
            host?.closeExternal()
            replyHandler(true, nil)

        case "copy":
            UIPasteboard.general.string = body["text"] as? String ?? ""
            replyHandler(true, nil)

        case "iapProducts":
            Task { @MainActor in
                do { replyHandler(try await StoreService.shared.loadProducts(), nil) }
                catch { replyHandler(nil, error.localizedDescription) }
            }

        case "iapPurchase":
            guard let id = body["id"] as? String, StoreService.allIDs.contains(id) else { return replyHandler(nil, "unknown product") }
            Task { @MainActor in replyHandler(await StoreService.shared.purchase(id), nil) }

        case "iapRestore":
            Task { @MainActor in replyHandler(await StoreService.shared.restore(), nil) }

        case "iapStatus":
            Task { @MainActor in replyHandler(await StoreService.shared.status(), nil) }

        case "iapManage":
            Task { @MainActor in
                await StoreService.shared.manageSubscriptions(in: self.host?.view.window?.windowScene)
                replyHandler(true, nil)
            }

        case "haptic":
            let style: UIImpactFeedbackGenerator.FeedbackStyle = (body["style"] as? String) == "heavy" ? .heavy : .light
            UIImpactFeedbackGenerator(style: style).impactOccurred()
            replyHandler(true, nil)

        default:
            replyHandler(nil, "unknown command: \(cmd)")
        }
    }
}

/// console.* from the page → NSLog (visible in Xcode, Console.app and the
/// CI simulator smoke test's log capture).
final class JSConsoleLogger: NSObject, WKScriptMessageHandler {
    private var count = 0
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard count < 5000, let body = message.body as? [String: Any] else { return }
        count += 1
        let level = body["level"] as? String ?? "log"
        let msg = body["msg"] as? String ?? ""
        NSLog("[JS %@] %@", level, msg)
    }
}
