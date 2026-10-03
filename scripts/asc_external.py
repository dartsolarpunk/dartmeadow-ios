#!/usr/bin/env python3
"""External TestFlight testing for DART Meadow: public group + test information
+ latest build submitted to Beta App Review. Idempotent. Never touches the
internal group. Phone numbers are never printed (masked)."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from asc import req, req_soft, get_all, summary, find_app  # noqa: E402

GROUP_NAME = "DART Meadow Public"
OLD_NAMES = {"DART Meadow Skyboarders"}
BUILD = os.environ.get("EXT_BUILD", "1791013911")
EMAIL = "dartmeadow@gmail.com"
DESC = ("Journey of the Skyboard — fly Ariel's skyboard across a hand-built galaxy, land on worlds with "
        "marching-cubes terrain, explore Earth relief and water, keep a flight journal, quick-travel, save "
        "slots, and meet other pilots in multiplayer. Sign in with Apple or GitHub, or play as a guest.")
WHATS_NEW = ("Native iOS build of DART Meadow: bundled game engine for faster loading, Sign in with Apple, "
             "friends + marker sharing, spectator free-fly camera, 3D landing globe with day/night lighting, "
             "music player updates, and in-app support purchases. Please report anything that feels off.")
NOTES = ("No account needed: tap Continue as Guest (or Sign in with Apple). Main menu → Launch to fly. "
         "Support purchases (❤ Support) are optional donations/subscription and unlock no content.")


def mask(p):
    return ("•" * max(0, len(p) - 2) + p[-2:]) if p else None


def main():
    summary("### External TestFlight (DART Meadow)")
    app = find_app(); aid = app["id"]

    # 1) external group with public link
    groups = get_all(f"/apps/{aid}/betaGroups")
    ext = [g for g in groups if not g["attributes"].get("isInternalGroup")]
    grp = next((g for g in ext if g["attributes"]["name"] == GROUP_NAME), None) or \
          next((g for g in ext if g["attributes"]["name"] in OLD_NAMES), None)
    attrs = {"name": GROUP_NAME, "publicLinkEnabled": True, "publicLinkLimitEnabled": True,
             "publicLinkLimit": 10000, "feedbackEnabled": True}
    if grp:
        r = req_soft("PATCH", f"/betaGroups/{grp['id']}", json={"data": {"type": "betaGroups", "id": grp["id"], "attributes": attrs}})
        if r.status_code >= 300:  # limit fields can be picky; retry minimal
            attrs = {"name": GROUP_NAME, "publicLinkEnabled": True}
            req_soft("PATCH", f"/betaGroups/{grp['id']}", json={"data": {"type": "betaGroups", "id": grp["id"], "attributes": attrs}})
    else:
        grp = req("POST", "/betaGroups", json={"data": {"type": "betaGroups", "attributes": attrs,
              "relationships": {"app": {"data": {"type": "apps", "id": aid}}}}})["data"]
    g = req("GET", f"/betaGroups/{grp['id']}")["data"]["attributes"]
    summary(f"- group **{g['name']}** internal={g.get('isInternalGroup')} publicLinkEnabled={g.get('publicLinkEnabled')} "
            f"limit={g.get('publicLinkLimit')} link: {g.get('publicLink')}")

    # 2a) beta app localization (test information)
    locs = req("GET", f"/apps/{aid}/betaAppLocalizations")["data"]
    la = {"description": DESC, "feedbackEmail": EMAIL, "marketingUrl": "https://dartmeadow.space",
          "privacyPolicyUrl": "https://dartmeadow.space/privacy.html"}
    en = next((l for l in locs if l["attributes"].get("locale") == "en-US"), None)
    if en:
        r = req_soft("PATCH", f"/betaAppLocalizations/{en['id']}", json={"data": {"type": "betaAppLocalizations", "id": en["id"], "attributes": la}})
    else:
        r = req_soft("POST", "/betaAppLocalizations", json={"data": {"type": "betaAppLocalizations",
            "attributes": dict(la, locale="en-US"), "relationships": {"app": {"data": {"type": "apps", "id": aid}}}}})
    summary(f"- betaAppLocalization en-US: HTTP {r.status_code}")

    # 2b) beta app review detail (contact). Phone: reuse the one already on Justin's other apps.
    detail = req("GET", f"/apps/{aid}/betaAppReviewDetail")["data"]
    phone = detail["attributes"].get("contactPhone")
    if not phone:
        for other in get_all("/apps"):
            if other["id"] == aid: continue
            r = req_soft("GET", f"/apps/{other['id']}/betaAppReviewDetail")
            if r.status_code == 200:
                a = (r.json().get("data") or {}).get("attributes") or {}
                summary(f"  · {other['attributes']['name']}: contact {a.get('contactFirstName')} {a.get('contactLastName')} "
                        f"{a.get('contactEmail')} phone {mask(a.get('contactPhone'))}")
                if a.get("contactPhone") and not phone:
                    phone = a["contactPhone"]
    da = {"contactFirstName": "Justin", "contactLastName": "Venable", "contactEmail": EMAIL,
          "demoAccountRequired": False, "notes": NOTES}
    if phone: da["contactPhone"] = phone
    r = req_soft("PATCH", f"/betaAppReviewDetails/{detail['id']}", json={"data": {"type": "betaAppReviewDetails", "id": detail["id"], "attributes": da}})
    summary(f"- betaAppReviewDetail: HTTP {r.status_code}; phone {'set ' + mask(phone) if phone else '**MISSING**'}")
    if not phone:
        summary("- ❌ stopping: Beta App Review needs a contact phone and none is on file")
        return 0

    # 3) build: export compliance, what's new, add to group, submit
    builds = req("GET", "/builds", params={"filter[app]": aid, "filter[version]": BUILD})["data"]
    if not builds:
        summary(f"- ❌ build {BUILD} not found"); return 1
    b = builds[0]; bid = b["id"]; ba = b["attributes"]
    if ba.get("usesNonExemptEncryption") is not False:
        req_soft("PATCH", f"/builds/{bid}", json={"data": {"type": "builds", "id": bid, "attributes": {"usesNonExemptEncryption": False}}})
    ba = req("GET", f"/builds/{bid}")["data"]["attributes"]
    summary(f"- build {BUILD}: processing={ba.get('processingState')} expired={ba.get('expired')} usesNonExemptEncryption={ba.get('usesNonExemptEncryption')}")
    bl = req("GET", f"/builds/{bid}/betaBuildLocalizations")["data"]
    en = next((l for l in bl if l["attributes"].get("locale") == "en-US"), None)
    if en:
        r = req_soft("PATCH", f"/betaBuildLocalizations/{en['id']}", json={"data": {"type": "betaBuildLocalizations", "id": en["id"], "attributes": {"whatsNew": WHATS_NEW}}})
    else:
        r = req_soft("POST", "/betaBuildLocalizations", json={"data": {"type": "betaBuildLocalizations",
            "attributes": {"locale": "en-US", "whatsNew": WHATS_NEW}, "relationships": {"build": {"data": {"type": "builds", "id": bid}}}}})
    summary(f"- whatsNew: HTTP {r.status_code}")
    r = req_soft("POST", f"/betaGroups/{grp['id']}/relationships/builds", json={"data": [{"type": "builds", "id": bid}]})
    summary(f"- build added to {GROUP_NAME}: HTTP {r.status_code}")
    sub = req_soft("GET", f"/builds/{bid}/betaAppReviewSubmission")
    cur = (sub.json().get("data") or None) if sub.status_code == 200 else None
    if not cur:
        r = req_soft("POST", "/betaAppReviewSubmissions", json={"data": {"type": "betaAppReviewSubmissions",
            "relationships": {"build": {"data": {"type": "builds", "id": bid}}}}})
        summary(f"- betaAppReviewSubmission POST: HTTP {r.status_code}")
        if r.status_code >= 300:
            try:
                for e in r.json().get("errors", []): summary(f"  - {e.get('code')}: {e.get('detail')}")
            except Exception: pass
        sub = req_soft("GET", f"/builds/{bid}/betaAppReviewSubmission")
        cur = (sub.json().get("data") or None) if sub.status_code == 200 else None
    summary(f"- Beta App Review state: **{(cur or {}).get('attributes', {}).get('betaReviewState')}** "
            f"(submitted {(cur or {}).get('attributes', {}).get('submittedDate')})")
    bd = req("GET", f"/builds/{bid}/buildBetaDetail")["data"]["attributes"]
    summary(f"- buildBetaDetail internal={bd.get('internalBuildState')} external={bd.get('externalBuildState')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
