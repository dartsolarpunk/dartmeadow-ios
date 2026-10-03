import UIKit
import AuthenticationServices
import CryptoKit

/// Native Sign in with Apple for the game.
///
/// Mirrors the pattern that works in Autumn-iOS (DART-Skyboard/Autumn-iOS
/// AuthViewModel + AppleSignInButton) and Ash Tree IDE:
///  * the ASAuthorizationController is created right before performRequests()
///    and held strongly until the delegate fires (a released controller, or
///    dismiss-then-perform, is what produced ASAuthorizationError 1000 there);
///  * the nonce is generated and SHA-256'd onto the request before
///    performRequests();
///  * the presentation anchor is the game's own key window;
///  * name/email (Apple sends them only the first time) are kept in the
///    Keychain against the Apple user id;
///  * 1000/1001 map to clear messages (1000 usually = device not signed into
///    an Apple Account, or Sign in with Apple capability missing from the
///    provisioning profile).
final class AppleSignInService: NSObject {
    struct Failure: Error { let message: String }

    private var controller: ASAuthorizationController?
    private var completion: ((Result<[String: Any], Failure>) -> Void)?
    private var rawNonce = ""
    private weak var anchor: UIWindow?
    private let store = KeychainStore(service: "space.dartmeadow.jots.apple")

    func signIn(anchor: UIWindow?, completion: @escaping (Result<[String: Any], Failure>) -> Void) {
        guard self.completion == nil else {
            return completion(.failure(Failure(message: "Sign in with Apple is already open.")))
        }
        self.anchor = anchor
        self.completion = completion

        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        rawNonce = Self.randomNonce()
        request.nonce = Self.sha256(rawNonce)

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller          // strong until the delegate answers
        controller.performRequests()
    }

    /// "authorized" | "revoked" | "notFound" | "transferred" | "none"
    func credentialState(_ done: @escaping (String, String?) -> Void) {
        guard let user = store.get("user") else { return done("none", nil) }
        ASAuthorizationAppleIDProvider().getCredentialState(forUserID: user) { state, _ in
            let s: String
            switch state {
            case .authorized: s = "authorized"
            case .revoked: s = "revoked"
            case .notFound: s = "notFound"
            case .transferred: s = "transferred"
            @unknown default: s = "unknown"
            }
            DispatchQueue.main.async { done(s, user) }
        }
    }

    /// Apple has no API sign-out; the game forgets the account on this device.
    func forget() {
        store.delete("user")
    }

    // MARK: Token revocation (account deletion, App Store guideline 5.1.1(v))
    //
    // Apple's REST /auth/token + /auth/revoke need a client_secret JWT signed
    // with a Sign in with Apple private key, which must never ship in the app.
    // A tiny server (server/siwa/ in this repo) holds the key; its base URL is
    // Info.plist DMSiwaServiceURL. Until it's configured, deletion still
    // forgets everything on the device and tells the page revocation is pending.

    static var serviceURL: URL? {
        guard let s = Bundle.main.object(forInfoDictionaryKey: "DMSiwaServiceURL") as? String,
              !s.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return URL(string: s)
    }

    private static func post(_ path: String, _ body: [String: Any], done: @escaping ([String: Any]?, String?) -> Void) {
        guard let base = serviceURL else { return done(nil, "not configured") }
        var r = URLRequest(url: base.appendingPathComponent(path))
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        r.timeoutInterval = 8
        URLSession.shared.dataTask(with: r) { data, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async {
                if let err { return done(nil, err.localizedDescription) }
                if code < 200 || code >= 300 { return done(json, (json?["error"] as? String) ?? "HTTP \(code)") }
                done(json ?? [:], nil)
            }
        }.resume()
    }

    /// Swap the one-time authorization code for a refresh token (kept in the Keychain) so it can be revoked later.
    private func exchange(code: String, user: String) {
        Self.post("token", ["code": code]) { [store] json, _ in
            if let rt = json?["refresh_token"] as? String, !rt.isEmpty { store.set("refresh.\(user)", rt) }
        }
    }

    /// Revoke this app's Sign in with Apple grant. done(nil) = revoked.
    func revoke(user: String?, done: @escaping (String?) -> Void) {
        let user = user.flatMap { $0.isEmpty ? nil : $0 } ?? store.get("user")
        guard Self.serviceURL != nil else {
            return done("Apple token revocation isn't set up in this build yet")
        }
        var body: [String: Any] = [:]
        if let u = user, let rt = store.get("refresh.\(u)") {
            body = ["token": rt, "token_type_hint": "refresh_token"]
        } else if let code = store.get("code"), let ts = Double(store.get("codeTs") ?? ""),
                  Date().timeIntervalSince1970 - ts < 290 {
            body = ["code": code]          // fresh code: the server exchanges then revokes
        } else {
            return done("no Apple token on this device to revoke (sign in with Apple again, then delete)")
        }
        Self.post("revoke", body) { _, err in done(err) }
    }

    /// Forget every Sign in with Apple value this app stored.
    func forgetAll(user: String?) {
        let u = user.flatMap { $0.isEmpty ? nil : $0 } ?? store.get("user")
        if let u { ["given", "family", "email", "refresh"].forEach { store.delete("\($0).\(u)") } }
        ["user", "code", "codeTs"].forEach { store.delete($0) }
    }

    private func finish(_ result: Result<[String: Any], Failure>) {
        let cb = completion
        completion = nil
        controller = nil
        cb?(result)
    }

    // MARK: Nonce

    static func randomNonce(length: Int = 32) -> String {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var bytes = [UInt8](repeating: 0, count: length)
        if SecRandomCopyBytes(kSecRandomDefault, length, &bytes) != errSecSuccess {
            return UUID().uuidString.replacingOccurrences(of: "-", with: "")
        }
        return String(bytes.map { charset[Int($0) % charset.count] })
    }

    static func sha256(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

extension AppleSignInService: ASAuthorizationControllerDelegate {
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let cred = authorization.credential as? ASAuthorizationAppleIDCredential else {
            return finish(.failure(Failure(message: "Apple returned an unexpected credential.")))
        }
        let user = cred.user
        store.set("user", user)
        // Apple only sends name/email on the first authorization: keep them.
        if let given = cred.fullName?.givenName, !given.isEmpty { store.set("given.\(user)", given) }
        if let family = cred.fullName?.familyName, !family.isEmpty { store.set("family.\(user)", family) }
        if let email = cred.email, !email.isEmpty { store.set("email.\(user)", email) }

        var payload: [String: Any] = [
            "user": user,
            "givenName": store.get("given.\(user)") ?? "",
            "familyName": store.get("family.\(user)") ?? "",
            "email": store.get("email.\(user)") ?? "",
            "nonce": rawNonce,
            "realUserStatus": cred.realUserStatus.rawValue,
        ]
        if let t = cred.identityToken, let s = String(data: t, encoding: .utf8) { payload["identityToken"] = s }
        if let c = cred.authorizationCode, let s = String(data: c, encoding: .utf8) {
            payload["authorizationCode"] = s
            store.set("code", s)
            store.set("codeTs", String(Date().timeIntervalSince1970))
            exchange(code: s, user: user)
        }
        finish(.success(payload))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let code = (error as? ASAuthorizationError)?.code
        let message: String
        switch code {
        case .canceled?:
            message = "canceled"
        case .unknown?:
            message = "Sign in with Apple couldn't start (1000). Make sure this device is signed in to an Apple Account in Settings, then try again."
        case .failed?:
            message = "Sign in with Apple failed. Please try again."
        case .invalidResponse?:
            message = "Apple sent an invalid response. Please try again."
        case .notHandled?:
            message = "Sign in with Apple wasn't handled. Please try again."
        case .notInteractive?:
            message = "Sign in with Apple needs you to confirm on screen."
        default:
            message = error.localizedDescription
        }
        NSLog("[SIWA] error %@ (%ld)", message, (error as NSError).code)
        finish(.failure(Failure(message: message)))
    }
}

extension AppleSignInService: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        if let anchor { return anchor }
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

/// Minimal generic-password Keychain wrapper.
struct KeychainStore {
    let service: String

    func set(_ key: String, _ value: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
        var add = q
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    func get(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: key,
                                kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    func delete(_ key: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
    }
}
