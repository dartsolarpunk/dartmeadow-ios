import UIKit
import AVFoundation

/// Journey of the Skyboard — native iOS shell.
///
/// The whole web game (dartsolarpunk/dartmeadow-space, see WEB_VERSION) ships
/// inside the app bundle under Web/ and runs on-device in a WKWebView served
/// from the `dartmeadow://localhost/` scheme (BundleSchemeHandler). The device
/// GPU renders everything locally (WebGPU where iOS offers it, WebGL fallback).
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Soundtrack + effects play like a game: through the speaker, with
        // the app in front, without waiting for a tap.
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [])
        try? session.setActive(true)
        return true
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.backgroundColor = Theme.launchBackground
        window.rootViewController = GameViewController()
        window.makeKeyAndVisible()
        self.window = window
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        try? AVAudioSession.sharedInstance().setActive(true)
        GameViewController.current?.appDidBecomeActive()
    }

    func sceneWillResignActive(_ scene: UIScene) {
        GameViewController.current?.appWillResignActive()
    }
}

enum Theme {
    /// #10081a — the PWA's theme/launch colour.
    static let launchBackground = UIColor(red: 0x10 / 255.0, green: 0x08 / 255.0, blue: 0x1a / 255.0, alpha: 1)
}
