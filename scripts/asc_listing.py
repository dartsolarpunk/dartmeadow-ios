#!/usr/bin/env python3
"""Publishing prep for DART Meadow (no submission):
  1) IAP: donation $4.99, alpha-supporter names/descriptions, notes, review screenshot
  2) App Store listing: version 1.0 en-US metadata, categories, age rating, Free price,
     availability, review contact, screenshots from Design/appstore/<DISPLAY_TYPE>/*.png
Never submits anything for review."""
import hashlib, json, os, sys
from pathlib import Path
import requests
sys.path.insert(0, os.path.dirname(__file__))
from asc import req, req_soft, get_all, summary, find_app  # noqa: E402
import asc_iap  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
L = json.loads((ROOT / "Design/appstore/listing.json").read_text())
V2 = "https://api.appstoreconnect.apple.com/v2"
IAP_NOTE = ("Optional support purchase behind the ❤ button on the main menu. DART Meadow is in early alpha; "
            "this purchase unlocks no content and only funds development (a thank-you is shown). "
            "No account needed: Continue as Guest.")
DON = dict(ref="Support Early Alpha — One-Time $4.99", name="Support Early Alpha",
           desc="One-time support for DART Meadow's early alpha.", price="4.99")
MON = dict(ref="Monthly Alpha Supporter $4.99", name="Monthly Alpha Supporter",
           desc="Monthly support for early alpha; renews until canceled")


def errs(r):
    try: return "; ".join(f"{e.get('code')}: {e.get('detail')}" for e in r.json().get("errors", []))
    except Exception: return r.text[:300]


def soft(label, r):
    ok = r.status_code < 300
    summary(f"- {label}: HTTP {r.status_code}" + ("" if ok else f" — {errs(r)}"))
    return ok


def replace_shot(get_url, create_path, rel_key, owner_type, owner_id):
    g = req_soft("GET", get_url)
    cur = (g.json().get("data") or None) if g.status_code == 200 else None
    if cur:
        req_soft("DELETE", f"{create_path}/{cur['id']}")
    return asc_iap.upload_screenshot(create_path, rel_key, owner_type, owner_id)


def iap(app_id):
    summary("### In-app purchases")
    # donation
    iap = next(i for i in get_all(f"/apps/{app_id}/inAppPurchasesV2") if i["attributes"]["productId"] == asc_iap.DONATION["productId"])
    iid = iap["id"]; v2 = f"{V2}/inAppPurchases/{iid}"
    soft("donation reference name/notes", req_soft("PATCH", v2, json={"data": {"type": "inAppPurchases", "id": iid,
         "attributes": {"name": DON["ref"], "reviewNote": IAP_NOTE}}}))
    for l in req("GET", v2 + "/inAppPurchaseLocalizations")["data"]:
        if l["attributes"]["locale"] == "en-US":
            soft("donation en-US name/description", req_soft("PATCH", f"/inAppPurchaseLocalizations/{l['id']}", json={"data": {
                "type": "inAppPurchaseLocalizations", "id": l["id"], "attributes": {"name": DON["name"], "description": DON["desc"]}}}))
    pts = req("GET", v2 + "/pricePoints", params={"filter[territory]": "USA", "limit": 8000})["data"]
    pp = next(x for x in pts if x["attributes"].get("customerPrice") == DON["price"])
    soft("donation price → $4.99 (USA base, auto-equalized)", req_soft("POST", "/inAppPurchasePriceSchedules", json={
        "data": {"type": "inAppPurchasePriceSchedules", "relationships": {
            "inAppPurchase": {"data": {"type": "inAppPurchases", "id": iid}},
            "baseTerritory": {"data": {"type": "territories", "id": "USA"}},
            "manualPrices": {"data": [{"type": "inAppPurchasePrices", "id": "${p1}"}]}}},
        "included": [{"type": "inAppPurchasePrices", "id": "${p1}", "attributes": {"startDate": None},
                      "relationships": {"inAppPurchasePricePoint": {"data": {"type": "inAppPurchasePricePoints", "id": pp["id"]}}}}]}))
    summary("- donation review screenshot: " + replace_shot(v2 + "/appStoreReviewScreenshot", "/inAppPurchaseAppStoreReviewScreenshots",
                                                             "inAppPurchaseV2", "inAppPurchases", iid))
    # verify price
    sch = req_soft("GET", v2 + "/iapPriceSchedule/manualPrices", params={"include": "inAppPurchasePricePoint", "filter[territory]": "USA"})
    if sch.status_code == 200:
        inc = [x["attributes"].get("customerPrice") for x in sch.json().get("included", []) if x["type"] == "inAppPurchasePricePoints"]
        summary(f"  · donation USA manual price now: {inc}")
    # subscription
    grp = next(g for g in get_all(f"/apps/{app_id}/subscriptionGroups") if g["attributes"]["referenceName"] == asc_iap.GROUP)
    sub = next(x for x in req("GET", f"/subscriptionGroups/{grp['id']}/subscriptions")["data"]
               if x["attributes"]["productId"] == asc_iap.MONTHLY["productId"])
    sid = sub["id"]
    soft("monthly reference name/notes", req_soft("PATCH", f"/subscriptions/{sid}", json={"data": {"type": "subscriptions", "id": sid,
         "attributes": {"name": MON["ref"], "reviewNote": IAP_NOTE}}}))
    for l in req("GET", f"/subscriptions/{sid}/subscriptionLocalizations")["data"]:
        if l["attributes"]["locale"] == "en-US":
            soft("monthly en-US name/description", req_soft("PATCH", f"/subscriptionLocalizations/{l['id']}", json={"data": {
                "type": "subscriptionLocalizations", "id": l["id"], "attributes": {"name": MON["name"], "description": MON["desc"]}}}))
    pr = req_soft("GET", f"/subscriptions/{sid}/prices", params={"filter[territory]": "USA", "include": "subscriptionPricePoint"})
    if pr.status_code == 200:
        inc = [x["attributes"].get("customerPrice") for x in pr.json().get("included", []) if x["type"] == "subscriptionPricePoints"]
        summary(f"  · monthly USA price: {inc}")
    summary("- monthly review screenshot: " + replace_shot(f"/subscriptions/{sid}/appStoreReviewScreenshot", "/subscriptionAppStoreReviewScreenshots",
                                                            "subscription", "subscriptions", sid))
    for i in get_all(f"/apps/{app_id}/inAppPurchasesV2"):
        summary(f"  · {i['attributes']['productId']}: {i['attributes'].get('state')}")
    for x in req("GET", f"/subscriptionGroups/{grp['id']}/subscriptions")["data"]:
        summary(f"  · {x['attributes']['productId']}: {x['attributes'].get('state')}")


AGE = {  # 2025+ age rating questionnaire
    "alcoholTobaccoOrDrugUseOrReferences": "NONE", "contests": "NONE", "gamblingSimulated": "NONE",
    "gunsOrOtherWeapons": "NONE", "horrorOrFearThemes": "NONE", "matureOrSuggestiveThemes": "NONE",
    "medicalOrTreatmentInformation": "NONE", "profanityOrCrudeHumor": "NONE",
    "sexualContentGraphicAndNudity": "NONE", "sexualContentOrNudity": "NONE",
    "violenceCartoonOrFantasy": "NONE", "violenceRealistic": "NONE",
    "violenceRealisticProlongedGraphicOrSadistic": "NONE",
    "gambling": False, "unrestrictedWebAccess": False, "lootBox": False, "advertising": False,
    "messagingAndChat": True, "userGeneratedContent": True, "parentalControls": False,
    "ageAssurance": False, "healthOrWellnessTopics": False,
}


def age_rating(app_info_id):
    d = req("GET", f"/appInfos/{app_info_id}/ageRatingDeclaration")["data"]
    attrs = dict(AGE)
    for _ in range(8):
        r = req_soft("PATCH", f"/ageRatingDeclarations/{d['id']}", json={"data": {"type": "ageRatingDeclarations", "id": d["id"], "attributes": attrs}})
        if r.status_code < 300:
            summary(f"- age rating questionnaire: saved ({len(attrs)} answers)"); break
        bad = [e.get("source", {}).get("pointer", "").split("/")[-1] for e in r.json().get("errors", [])]
        bad = [b for b in bad if b in attrs]
        summary(f"  · age rating rejected {bad or errs(r)}")
        if not bad: break
        for b in bad: attrs.pop(b, None)
    a = req("GET", f"/appInfos/{app_info_id}/ageRatingDeclaration")["data"]["attributes"]
    summary("  · stored: " + ", ".join(f"{k}={v}" for k, v in a.items() if v not in (None, "NONE", False)))


def listing(app_id):
    summary("### App Store listing (not submitted)")
    infos = req("GET", f"/apps/{app_id}/appInfos")["data"]
    info = next((i for i in infos if i["attributes"].get("appStoreState") in ("PREPARE_FOR_SUBMISSION", None) or
                 i["attributes"].get("state") in ("PREPARE_FOR_SUBMISSION",)), infos[0])
    iid = info["id"]
    soft("categories Games › Adventure + Simulation", req_soft("PATCH", f"/appInfos/{iid}", json={"data": {"type": "appInfos", "id": iid, "relationships": {
        "primaryCategory": {"data": {"type": "appCategories", "id": "GAMES"}},
        "primarySubcategoryOne": {"data": {"type": "appCategories", "id": "GAMES_ADVENTURE"}},
        "primarySubcategoryTwo": {"data": {"type": "appCategories", "id": "GAMES_SIMULATION"}}}}}))
    for l in req("GET", f"/appInfos/{iid}/appInfoLocalizations")["data"]:
        if l["attributes"]["locale"] == "en-US":
            soft("subtitle + privacy URL", req_soft("PATCH", f"/appInfoLocalizations/{l['id']}", json={"data": {"type": "appInfoLocalizations", "id": l["id"],
                 "attributes": {"subtitle": L["subtitle"], "privacyPolicyUrl": L["privacyPolicyUrl"]}}}))
            summary(f"  · app name: {l['attributes'].get('name')}")
    age_rating(iid)

    # price: Free
    pts = get_all(f"/apps/{app_id}/appPricePoints", {"filter[territory]": "USA"})
    free = next((p for p in pts if float(p["attributes"].get("customerPrice") or 1) == 0.0), None)
    if free:
        soft("price: Free", req_soft("POST", "/appPriceSchedules", json={
            "data": {"type": "appPriceSchedules", "relationships": {
                "app": {"data": {"type": "apps", "id": app_id}},
                "baseTerritory": {"data": {"type": "territories", "id": "USA"}},
                "manualPrices": {"data": [{"type": "appPrices", "id": "${f}"}]}}},
            "included": [{"type": "appPrices", "id": "${f}", "attributes": {"startDate": None},
                          "relationships": {"appPricePoint": {"data": {"type": "appPricePoints", "id": free["id"]}}}}]}))
    # availability: all territories
    have = req_soft("GET", f"/apps/{app_id}/appAvailabilityV2")
    if have.status_code == 200 and have.json().get("data"):
        summary("- availability: already set")
    else:
        terr = [t["id"] for t in get_all("/territories")]
        soft(f"availability: all {len(terr)} territories + new ones", req_soft("POST", f"{V2}/appAvailabilities", json={
            "data": {"type": "appAvailabilities", "attributes": {"availableInNewTerritories": True},
                     "relationships": {"app": {"data": {"type": "apps", "id": app_id}},
                                       "territoryAvailabilities": {"data": [{"type": "territoryAvailabilities", "id": f"${{{t}}}"} for t in terr]}}},
            "included": [{"type": "territoryAvailabilities", "id": f"${{{t}}}", "attributes": {"available": True},
                          "relationships": {"territory": {"data": {"type": "territories", "id": t}}}} for t in terr]}))

    # version 1.0
    vers = req("GET", f"/apps/{app_id}/appStoreVersions", params={"filter[platform]": "IOS"})["data"]
    ver = next((v for v in vers if v["attributes"].get("appStoreState") in ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED")), None)
    if not ver:
        r = req_soft("POST", "/appStoreVersions", json={"data": {"type": "appStoreVersions",
            "attributes": {"platform": "IOS", "versionString": "1.0", "copyright": L["copyright"], "releaseType": "MANUAL"},
            "relationships": {"app": {"data": {"type": "apps", "id": app_id}}}}})
        soft("create version 1.0", r); ver = r.json()["data"]
    vid = ver["id"]
    soft("version copyright/manual release", req_soft("PATCH", f"/appStoreVersions/{vid}", json={"data": {"type": "appStoreVersions", "id": vid,
         "attributes": {"copyright": L["copyright"], "releaseType": "MANUAL"}}}))
    locs = req("GET", f"/appStoreVersions/{vid}/appStoreVersionLocalizations")["data"]
    en = next((l for l in locs if l["attributes"]["locale"] == "en-US"), None)
    la = {k: L[k] for k in ("description", "keywords", "promotionalText", "supportUrl", "marketingUrl")}
    if en:
        soft("version en-US description/keywords/promo/URLs", req_soft("PATCH", f"/appStoreVersionLocalizations/{en['id']}", json={"data": {
            "type": "appStoreVersionLocalizations", "id": en["id"], "attributes": la}}))
    else:
        r = req_soft("POST", "/appStoreVersionLocalizations", json={"data": {"type": "appStoreVersionLocalizations",
            "attributes": dict(la, locale="en-US"), "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": vid}}}}})
        soft("version en-US localization", r); en = r.json()["data"]
    # review contact
    rd = req_soft("GET", f"/appStoreVersions/{vid}/appStoreReviewDetail")
    bphone = req("GET", f"/apps/{app_id}/betaAppReviewDetail")["data"]["attributes"].get("contactPhone")
    ra = {"contactFirstName": "Justin", "contactLastName": "Venable", "contactEmail": "dartmeadow@gmail.com",
          "contactPhone": bphone, "demoAccountRequired": False, "notes": L["reviewNotes"]}
    if rd.status_code == 200 and rd.json().get("data"):
        d = rd.json()["data"]
        soft("App Review contact/notes", req_soft("PATCH", f"/appStoreReviewDetails/{d['id']}", json={"data": {"type": "appStoreReviewDetails", "id": d["id"], "attributes": ra}}))
    else:
        soft("App Review contact/notes", req_soft("POST", "/appStoreReviewDetails", json={"data": {"type": "appStoreReviewDetails", "attributes": ra,
             "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": vid}}}}}))
    screenshots(en["id"])
    v = req("GET", f"/appStoreVersions/{vid}")["data"]["attributes"]
    summary(f"- version {v.get('versionString')} state **{v.get('appStoreState')}** (not submitted)")
    a = req("GET", f"/apps/{app_id}")["data"]["attributes"]
    summary(f"- contentRightsDeclaration: {a.get('contentRightsDeclaration')}")


def screenshots(loc_id):
    base = ROOT / "Design/appstore"
    for d in sorted(p for p in base.iterdir() if p.is_dir() and p.name.startswith("APP_")):
        files = sorted(d.glob("*.png"))
        if not files: continue
        sets = req("GET", f"/appStoreVersionLocalizations/{loc_id}/appScreenshotSets")["data"]
        s = next((x for x in sets if x["attributes"]["screenshotDisplayType"] == d.name), None)
        if s:
            for old in req("GET", f"/appScreenshotSets/{s['id']}/appScreenshots")["data"]:
                req_soft("DELETE", f"/appScreenshots/{old['id']}")
        else:
            s = req("POST", "/appScreenshotSets", json={"data": {"type": "appScreenshotSets", "attributes": {"screenshotDisplayType": d.name},
                "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": loc_id}}}}})["data"]
        ok = 0
        for f in files:
            data = f.read_bytes()
            r = req_soft("POST", "/appScreenshots", json={"data": {"type": "appScreenshots", "attributes": {"fileName": f.name, "fileSize": len(data)},
                "relationships": {"appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": s["id"]}}}}})
            if r.status_code >= 300:
                summary(f"  · {d.name}/{f.name}: reserve failed {errs(r)}"); continue
            sd = r.json()["data"]
            for op in sd["attributes"].get("uploadOperations") or []:
                h = {x["name"]: x["value"] for x in op.get("requestHeaders") or []}
                requests.request(op["method"], op["url"], headers=h, data=data[op["offset"]:op["offset"] + op["length"]], timeout=120)
            r2 = req_soft("PATCH", f"/appScreenshots/{sd['id']}", json={"data": {"type": "appScreenshots", "id": sd["id"],
                 "attributes": {"uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()}}})
            ok += r2.status_code < 300
        summary(f"- screenshots {d.name}: {ok}/{len(files)} uploaded")


def main():
    app = find_app()
    for fn in (iap, listing):
        try: fn(app["id"])
        except Exception as e: summary(f"- ❌ {fn.__name__} failed: {e!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
