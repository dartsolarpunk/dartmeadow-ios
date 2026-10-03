import Foundation
import StoreKit
import UIKit

/// StoreKit 2 support purchases for the game's ❤ SUPPORT modal:
///  * Game Development Support   — $9.99 consumable donation (buy as often as you like)
///  * Game Development Supporter — $4.99 / month auto-renewing subscription
///                                 (group "DART Meadow Support"; renews until cancelled)
@MainActor
final class StoreService {
    static let shared = StoreService()

    static let donationID = "com.dartmeadow.jots.support.donation"
    static let monthlyID = "com.dartmeadow.jots.support.monthly"
    static let allIDs = [donationID, monthlyID]

    private(set) var products: [String: Product] = [:]
    private var updatesTask: Task<Void, Never>?
    /// Called with a JSON-able status dict whenever entitlements change.
    var onChange: (([String: Any]) -> Void)?

    func start() {
        guard updatesTask == nil else { return }
        updatesTask = Task { [weak self] in
            for await update in Transaction.updates {
                guard let self else { return }
                if case .verified(let t) = update {
                    await t.finish()
                    let status = await self.status()
                    self.onChange?(status.merging(["event": "update", "productId": t.productID]) { a, _ in a })
                }
            }
        }
        Task { _ = try? await loadProducts() }
    }

    @discardableResult
    func loadProducts() async throws -> [[String: Any]] {
        let list = try await Product.products(for: Self.allIDs)
        for p in list { products[p.id] = p }
        return Self.allIDs.compactMap { products[$0] }.map(Self.describe)
    }

    static func describe(_ p: Product) -> [String: Any] {
        var d: [String: Any] = [
            "id": p.id,
            "displayName": p.displayName,
            "description": p.description,
            "displayPrice": p.displayPrice,
            "price": NSDecimalNumber(decimal: p.price).doubleValue,
            "type": p.type == .autoRenewable ? "subscription" : (p.type == .consumable ? "consumable" : "other"),
        ]
        if let sub = p.subscription {
            let u = sub.subscriptionPeriod.unit
            d["period"] = u == .month ? "month" : u == .year ? "year" : u == .week ? "week" : "day"
        }
        return d
    }

    func purchase(_ id: String) async -> [String: Any] {
        do {
            if products[id] == nil { _ = try await loadProducts() }
            guard let product = products[id] else {
                return ["status": "unavailable", "message": "This purchase isn't available right now."]
            }
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                switch verification {
                case .verified(let t):
                    await t.finish()
                    var out = await status()
                    out["status"] = "success"
                    out["productId"] = t.productID
                    return out
                case .unverified(_, let err):
                    return ["status": "failed", "message": "Apple couldn't verify the purchase (\(err.localizedDescription))."]
                }
            case .pending:
                return ["status": "pending", "message": "Waiting for approval (Ask to Buy or payment check)."]
            case .userCancelled:
                return ["status": "cancelled"]
            @unknown default:
                return ["status": "failed", "message": "Unknown purchase result."]
            }
        } catch {
            return ["status": "failed", "message": error.localizedDescription]
        }
    }

    func restore() async -> [String: Any] {
        do { try await AppStore.sync() } catch {
            var s = await status(); s["message"] = error.localizedDescription; return s
        }
        return await status()
    }

    /// Current supporter status (active monthly subscription).
    func status() async -> [String: Any] {
        var out: [String: Any] = ["subscribed": false]
        for await ent in Transaction.currentEntitlements {
            guard case .verified(let t) = ent, t.productID == Self.monthlyID, t.revocationDate == nil else { continue }
            out["subscribed"] = true
            if let exp = t.expirationDate { out["expires"] = ISO8601DateFormatter().string(from: exp) }
        }
        if let p = products[Self.monthlyID], let sub = p.subscription,
           let statuses = try? await sub.status, let st = statuses.first, case .verified(let info) = st.renewalInfo {
            out["willRenew"] = info.willAutoRenew
        }
        return out
    }

    func manageSubscriptions(in scene: UIWindowScene?) async {
        if let scene { try? await AppStore.showManageSubscriptions(in: scene) }
    }
}
