import UIKit
import WebKit
import SafariServices

/// Full-screen host for the bundled game.
final class GameViewController: UIViewController {
    static weak var current: GameViewController?

    private(set) var webView: WKWebView!
    private let schemeHandler = BundleSchemeHandler()
    private var bridge: NativeBridge!
    private weak var externalBrowser: SFSafariViewController?
    private var externalOpenedForGitHub = false
    private var crashReloads = 0

    // MARK: Chrome

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        // -dmLandscape: CI App Store screenshot runs only (never set in normal launches).
        if ProcessInfo.processInfo.arguments.contains("-dmLandscape") { return .landscapeRight }
        return UIDevice.current.userInterfaceIdiom == .pad ? .all : .allButUpsideDown
    }

    // MARK: Lifecycle

    override func loadView() {
        GameViewController.current = self
        bridge = NativeBridge(host: self)

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: BundleSchemeHandler.scheme)
        config.websiteDataStore = .default()                 // saves, settings, journal persist
        config.allowsInlineMediaPlayback = true              // splash plate + soundtrack inline
        config.mediaTypesRequiringUserActionForPlayback = [] // soundtrack/splash start without a tap
        config.allowsAirPlayForMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = false
        config.suppressesIncrementalRendering = false
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        // Look like Mobile Safari so the game takes its tested iOS/Safari
        // paths (GFX.isSafari / isIOS), plus an app token for analytics.
        let os = UIDevice.current.systemVersion.split(separator: ".").prefix(2).joined(separator: ".")
        config.applicationNameForUserAgent = "Version/\(os) Mobile/15E148 Safari/604.1 DARTMeadowApp/\(AppInfo.version)"

        let ucc = config.userContentController
        ucc.addUserScript(WKUserScript(source: NativeBridge.bootScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if let url = Bundle.main.url(forResource: "dm-ios-bridge", withExtension: "js"),
           let src = try? String(contentsOf: url, encoding: .utf8) {
            ucc.addUserScript(WKUserScript(source: src, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        ucc.addScriptMessageHandler(bridge, contentWorld: .page, name: "dmNative")
        ucc.add(bridge.logger, name: "dmLog")

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.isOpaque = false
        wv.backgroundColor = Theme.launchBackground
        wv.scrollView.backgroundColor = Theme.launchBackground
        wv.scrollView.isScrollEnabled = false
        wv.scrollView.bounces = false
        wv.scrollView.alwaysBounceVertical = false
        wv.scrollView.alwaysBounceHorizontal = false
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.scrollView.pinchGestureRecognizer?.isEnabled = false
        wv.allowsBackForwardNavigationGestures = false
        wv.allowsLinkPreview = false
        if #available(iOS 16.4, *) { wv.isInspectable = true }  // Safari ▸ Develop for debugging
        webView = wv
        view = wv
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        setNeedsUpdateOfHomeIndicatorAutoHidden()
        setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
        webView.load(URLRequest(url: BundleSchemeHandler.startURL))
    }

    func appDidBecomeActive() {
        evaluate("window.dispatchEvent(new CustomEvent('dmnative:active'))")
    }

    func appWillResignActive() {
        evaluate("window.dispatchEvent(new CustomEvent('dmnative:inactive'))")
    }

    func evaluate(_ js: String) {
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: External pages (GitHub sign-in, links, support)

    func openExternal(_ url: URL) {
        guard let scheme = url.scheme?.lowercased() else { return }
        if scheme == "http" || scheme == "https" {
            if let open = externalBrowser {
                // the game re-pointed its "GitHub tab": replace it
                open.dismiss(animated: false)
            }
            let cfg = SFSafariViewController.Configuration()
            cfg.entersReaderIfAvailable = false
            let safari = SFSafariViewController(url: url, configuration: cfg)
            safari.preferredBarTintColor = Theme.launchBackground
            safari.preferredControlTintColor = UIColor(red: 0.36, green: 0.5, blue: 1, alpha: 1)
            safari.dismissButtonStyle = .done
            safari.delegate = self
            externalOpenedForGitHub = (url.host ?? "").hasSuffix("github.com")
            externalBrowser = safari
            topPresenter().present(safari, animated: true)
        } else {
            UIApplication.shared.open(url)
        }
    }

    /// The game's `window.close()` on the GitHub tab it opened.
    func closeExternal() {
        externalBrowser?.dismiss(animated: true) { [weak self] in self?.externalClosed() }
    }

    private func externalClosed() {
        externalBrowser = nil
        // Back from GitHub: let the device-code sign-in check right away.
        let wasGitHub = externalOpenedForGitHub
        externalOpenedForGitHub = false
        evaluate("""
        try{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new CustomEvent('dmnative:externalClosed'));}catch(e){}
        \(wasGitHub ? "try{if(window.JOTS&&!JOTS.auth.signedIn&&JOTS.auth._wake)JOTS.auth.pollNow();}catch(e){}" : "")
        """)
    }

    func topPresenter() -> UIViewController {
        var vc: UIViewController = self
        while let p = vc.presentedViewController, !p.isBeingDismissed { vc = p }
        return vc
    }

    // MARK: Share sheet for downloads (save exports, board profiles, screenshots)

    func share(fileURL: URL) {
        let ac = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        if let pop = ac.popoverPresentationController {
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        topPresenter().present(ac, animated: true)
    }
}

// MARK: - Navigation

extension GameViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.cancel) }
        if scheme == BundleSchemeHandler.scheme || scheme == "about" || scheme == "blob" || scheme == "data" {
            return decisionHandler(.allow)
        }
        // iframes (e.g. the Stripe support button) load in place
        if let frame = action.targetFrame, !frame.isMainFrame { return decisionHandler(.allow) }
        // anything that would navigate the game away opens on top instead
        openExternal(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // iOS reclaimed the web process (usually GPU memory). Bring the game
        // straight back; saves live in localStorage / the player's repo.
        crashReloads += 1
        NSLog("[game] web content process terminated (#%d) — reloading", crashReloads)
        webView.load(URLRequest(url: BundleSchemeHandler.startURL))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if crashReloads > 0 {
            evaluate("window.__dmNativeRecovered=\(crashReloads);")
        }
        // CI simulator smoke test: tap through the splash on its own.
        if ProcessInfo.processInfo.arguments.contains("-dmSmoke") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
                self?.evaluate("""
                (function(){
                  var log=function(){ console.log.apply(console, ['[dm-smoke]'].concat([].slice.call(arguments))); };
                  var scr=function(){ return (typeof STATE!=='undefined'&&STATE.screen)||'?'; };
                  log('screen before enter:', scr());
                  try{ enterApp(); }catch(e){ console.error('[dm-smoke] enterApp failed', e); }
                  setTimeout(function(){ try{ if(document.getElementById('gfx-apply')) applyGfxScreen(); }catch(e){ console.error('[dm-smoke] gfx apply', e); } log('after gfx:', scr(), 'three:', !!window.__THREE_READY__); }, 6000);
                  setTimeout(function(){
                    try{ JOTS.consent.agree(); JOTS.auth.guest(); var w=document.getElementById('jots-welcome'); if(w) w.classList.remove('show'); }catch(e){}
                    try{ launchFlight(); }catch(e){ console.error('[dm-smoke] launchFlight', e); }
                    setTimeout(function(){ var b=document.getElementById('jots-mode-story'); if(b&&document.getElementById('jots-mode').classList.contains('show')) b.click(); log('flight requested; screen:', scr()); }, 1500);
                  }, 20000);
                  setTimeout(function(){ var caps={}; try{ caps=window.__jotsGpuCaps(); }catch(e){} log('t+80s screen:', scr(), 'caps:', JSON.stringify(caps)); }, 80000);
                })();
                """)
            }
        }
    }
}

// MARK: - Downloads → share sheet

extension GameViewController: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("exports", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent(suggestedFilename.isEmpty ? "dartmeadow-export" : suggestedFilename)
        try? FileManager.default.removeItem(at: dest)
        pendingDownloads[ObjectIdentifier(download)] = dest
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let dest = pendingDownloads.removeValue(forKey: ObjectIdentifier(download)) { share(fileURL: dest) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        pendingDownloads.removeValue(forKey: ObjectIdentifier(download))
        NSLog("[game] download failed: %@", error.localizedDescription)
    }
}

private var pendingDownloads = [ObjectIdentifier: URL]()

// MARK: - Windows, alerts, prompts

extension GameViewController: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme != BundleSchemeHandler.scheme { openExternal(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        topPresenter().present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        topPresenter().present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        topPresenter().present(a, animated: true)
    }
}

extension GameViewController: SFSafariViewControllerDelegate {
    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        externalClosed()
    }
}

enum AppInfo {
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0" }
    static var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0" }
    static var webVersion: String {
        guard let url = Bundle.main.url(forResource: "WEB_VERSION", withExtension: nil),
              let s = try? String(contentsOf: url, encoding: .utf8) else { return "unknown" }
        return s.split(separator: "\n").first(where: { $0.hasPrefix("sha=") }).map { String($0.dropFirst(4)) } ?? "unknown"
    }
}
