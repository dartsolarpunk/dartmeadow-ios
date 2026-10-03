#!/usr/bin/env python3
"""Create / update DART Meadow's support purchases in App Store Connect.

  * com.dartmeadow.jots.support.donation  CONSUMABLE  "Game Development Support"   $9.99
  * com.dartmeadow.jots.support.monthly   ONE_MONTH   "Game Development Supporter" $4.99/mo
    in subscription group "DART Meadow Support"

Idempotent: finds existing items by product id and fills in whatever is
missing (en-US localization, price, availability in all territories, review
screenshot). Uses the helpers in asc.py.
"""
import hashlib, os, sys
from pathlib import Path
import requests

sys.path.insert(0, os.path.dirname(__file__))
import asc  # noqa: E402
from asc import req, req_soft, get_all, summary, find_app  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SHOT = ROOT / "Design" / "iap-review-screenshot.png"
DONATION = dict(productId="com.dartmeadow.jots.support.donation", name="Game Development Support",
                desc="A one-time donation that funds new worlds and features.", price="9.99")
MONTHLY = dict(productId="com.dartmeadow.jots.support.monthly", name="Game Development Supporter",
               desc="Monthly support for DART Meadow. Renews until cancelled.", price="4.99")
GROUP = "DART Meadow Support"
REVIEW_NOTE = ("Optional support purchase in the ❤ SUPPORT menu (Main menu → Settings → Support DART Meadow). "
               "It unlocks no content; it only funds development and shows a thank-you.")


def all_territories():
    return [t["id"] for t in get_all("/territories")]


def upload_screenshot(create_path, rel_key, owner_type, owner_id):
    data = SHOT.read_bytes()
    r = req_soft("POST", create_path, json={"data": {"type": create_path.strip("/").split("/")[-1],
        "attributes": {"fileName": SHOT.name, "fileSize": len(data)},
        "relationships": {rel_key: {"data": {"type": owner_type, "id": owner_id}}}}})
    if r.status_code >= 300:
        return f"screenshot reserve failed HTTP {r.status_code}"
    d = r.json()["data"]
    for op in d["attributes"].get("uploadOperations") or []:
        h = {x["name"]: x["value"] for x in op.get("requestHeaders") or []}
        chunk = data[op["offset"]:op["offset"] + op["length"]]
        up = requests.request(op["method"], op["url"], headers=h, data=chunk, timeout=120)
        print("upload part", up.status_code)
    r2 = req_soft("PATCH", f"{create_path}/{d['id']}", json={"data": {"type": d["type"], "id": d["id"],
        "attributes": {"uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()}}})
    return f"screenshot uploaded (HTTP {r2.status_code})"


# ── consumable ──────────────────────────────────────────────────────────
def ensure_donation(app_id, territories):
    p = DONATION
    found = [i for i in get_all(f"/apps/{app_id}/inAppPurchasesV2") if i["attributes"].get("productId") == p["productId"]]
    iap = found[0] if found else None
    if not iap:
        url = "https://api.appstoreconnect.apple.com/v2/inAppPurchases"
        iap = req("POST", url, json={"data": {"type": "inAppPurchases", "attributes": {
            "name": p["name"], "productId": p["productId"], "inAppPurchaseType": "CONSUMABLE",
            "reviewNote": REVIEW_NOTE, "familySharable": False},
            "relationships": {"app": {"data": {"type": "apps", "id": app_id}}}}})["data"]
    iid = iap["id"]
    v2 = "https://api.appstoreconnect.apple.com/v2/inAppPurchases/" + iid
    # localization
    locs = req("GET", v2 + "/inAppPurchaseLocalizations")["data"]
    if not any(l["attributes"].get("locale") == "en-US" for l in locs):
        req_soft("POST", "/inAppPurchaseLocalizations", json={"data": {"type": "inAppPurchaseLocalizations",
            "attributes": {"locale": "en-US", "name": p["name"], "description": p["desc"]},
            "relationships": {"inAppPurchaseV2": {"data": {"type": "inAppPurchases", "id": iid}}}}})
    # price ($9.99 USA base, Apple equalizes the rest)
    pts = req("GET", v2 + "/pricePoints", params={"filter[territory]": "USA", "limit": 8000})["data"]
    pp = next((x for x in pts if x["attributes"].get("customerPrice") == p["price"]), None)
    if pp:
        req_soft("POST", "/inAppPurchasePriceSchedules", json={
            "data": {"type": "inAppPurchasePriceSchedules", "relationships": {
                "inAppPurchase": {"data": {"type": "inAppPurchases", "id": iid}},
                "baseTerritory": {"data": {"type": "territories", "id": "USA"}},
                "manualPrices": {"data": [{"type": "inAppPurchasePrices", "id": "${price1}"}]}}},
            "included": [{"type": "inAppPurchasePrices", "id": "${price1}", "attributes": {"startDate": None},
                          "relationships": {"inAppPurchasePricePoint": {"data": {"type": "inAppPurchasePricePoints", "id": pp["id"]}}}}]})
    else:
        summary(f"- donation: no ${p['price']} price point found")
    # availability
    req_soft("POST", "/inAppPurchaseAvailabilities", json={"data": {"type": "inAppPurchaseAvailabilities",
        "attributes": {"availableInNewTerritories": True},
        "relationships": {"inAppPurchase": {"data": {"type": "inAppPurchases", "id": iid}},
                          "availableTerritories": {"data": [{"type": "territories", "id": t} for t in territories]}}}})
    # review screenshot
    shot = req_soft("GET", v2 + "/appStoreReviewScreenshot")
    has = shot.status_code == 200 and (shot.json().get("data") or None)
    s = "screenshot present" if has else upload_screenshot("/inAppPurchaseAppStoreReviewScreenshots", "inAppPurchaseV2", "inAppPurchases", iid)
    st = req("GET", v2)["data"]["attributes"].get("state")
    summary(f"- **{p['productId']}** (consumable, {p['name']}, ${p['price']}): id {iid}, state **{st}**; {s}")


# ── subscription ────────────────────────────────────────────────────────
def ensure_monthly(app_id, territories):
    p = MONTHLY
    groups = get_all(f"/apps/{app_id}/subscriptionGroups")
    grp = next((g for g in groups if g["attributes"].get("referenceName") == GROUP), None)
    if not grp:
        grp = req("POST", "/subscriptionGroups", json={"data": {"type": "subscriptionGroups",
            "attributes": {"referenceName": GROUP},
            "relationships": {"app": {"data": {"type": "apps", "id": app_id}}}}})["data"]
    gid = grp["id"]
    glocs = req("GET", f"/subscriptionGroups/{gid}/subscriptionGroupLocalizations")["data"]
    if not any(l["attributes"].get("locale") == "en-US" for l in glocs):
        req_soft("POST", "/subscriptionGroupLocalizations", json={"data": {"type": "subscriptionGroupLocalizations",
            "attributes": {"locale": "en-US", "name": GROUP, "customAppName": "DART Meadow"},
            "relationships": {"subscriptionGroup": {"data": {"type": "subscriptionGroups", "id": gid}}}}})
    subs = req("GET", f"/subscriptionGroups/{gid}/subscriptions")["data"]
    sub = next((x for x in subs if x["attributes"].get("productId") == p["productId"]), None)
    if not sub:
        sub = req("POST", "/subscriptions", json={"data": {"type": "subscriptions", "attributes": {
            "name": p["name"], "productId": p["productId"], "subscriptionPeriod": "ONE_MONTH",
            "familySharable": False, "reviewNote": REVIEW_NOTE, "groupLevel": 1},
            "relationships": {"group": {"data": {"type": "subscriptionGroups", "id": gid}}}}})["data"]
    sid = sub["id"]
    locs = req("GET", f"/subscriptions/{sid}/subscriptionLocalizations")["data"]
    if not any(l["attributes"].get("locale") == "en-US" for l in locs):
        req_soft("POST", "/subscriptionLocalizations", json={"data": {"type": "subscriptionLocalizations",
            "attributes": {"locale": "en-US", "name": p["name"], "description": p["desc"]},
            "relationships": {"subscription": {"data": {"type": "subscriptions", "id": sid}}}}})
    # availability first (prices are only accepted for available territories)
    req_soft("POST", "/subscriptionAvailabilities", json={"data": {"type": "subscriptionAvailabilities",
        "attributes": {"availableInNewTerritories": True},
        "relationships": {"subscription": {"data": {"type": "subscriptions", "id": sid}},
                          "availableTerritories": {"data": [{"type": "territories", "id": t} for t in territories]}}}})
    # price: $4.99 in the USA + Apple's equalized price in every other territory
    existing = req_soft("GET", f"/subscriptions/{sid}/prices", params={"limit": 200})
    have = len((existing.json().get("data") or [])) if existing.status_code == 200 else 0
    if have < 2:
        pts = get_all(f"/subscriptions/{sid}/pricePoints", {"filter[territory]": "USA"})
        pp = next((x for x in pts if x["attributes"].get("customerPrice") == p["price"]), None)
        if not pp:
            summary(f"- monthly: no ${p['price']} price point found")
        else:
            targets = [pp] + get_all(f"/subscriptionPricePoints/{pp['id']}/equalizations")
            ok = 0
            for t in targets:
                r = req_soft("POST", "/subscriptionPrices", json={"data": {"type": "subscriptionPrices",
                    "attributes": {"startDate": None, "preserveCurrentPrice": False},
                    "relationships": {"subscription": {"data": {"type": "subscriptions", "id": sid}},
                                      "subscriptionPricePoint": {"data": {"type": "subscriptionPricePoints", "id": t["id"]}}}}})
                ok += r.status_code < 300
            summary(f"- monthly: set prices in {ok}/{len(targets)} territories")
    shot = req_soft("GET", f"/subscriptions/{sid}/appStoreReviewScreenshot")
    has = shot.status_code == 200 and (shot.json().get("data") or None)
    s = "screenshot present" if has else upload_screenshot("/subscriptionAppStoreReviewScreenshots", "subscription", "subscriptions", sid)
    st = req("GET", f"/subscriptions/{sid}")["data"]["attributes"].get("state")
    summary(f"- **{p['productId']}** (auto-renewable monthly, group \"{GROUP}\", {p['name']}, ${p['price']}/mo): id {sid}, state **{st}**; {s}")


def main():
    summary("### In-app purchases")
    app = find_app()
    terr = all_territories()
    summary(f"- {len(terr)} territories")
    for fn in (ensure_donation, ensure_monthly):
        try:
            fn(app["id"], terr)
        except Exception as e:
            summary(f"- {fn.__name__} failed: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
