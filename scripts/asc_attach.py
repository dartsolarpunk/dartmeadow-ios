#!/usr/bin/env python3
"""Attach the newest VALID build to App Store version 1.0 (no submission) and report readiness."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from asc import req, req_soft, get_all, summary, find_app  # noqa: E402


def errs(r):
    try: return "; ".join(f"{e.get('code')}: {e.get('detail')}" for e in r.json().get("errors", []))
    except Exception: return r.text[:300]


def main():
    summary("### Attach build to App Store version (not submitted)")
    app = find_app(); aid = app["id"]
    b = req("GET", "/builds", params={"filter[app]": aid, "sort": "-uploadedDate", "limit": 1,
                                      "filter[processingState]": "VALID", "include": "preReleaseVersion"})
    build = b["data"][0]
    pre = next((x for x in b.get("included", []) if x["type"] == "preReleaseVersions"), None)
    short = pre["attributes"]["version"] if pre else None
    summary(f"- newest build {build['attributes']['version']} (CFBundleShortVersionString {short})")
    vers = req("GET", f"/apps/{aid}/appStoreVersions", params={"filter[platform]": "IOS"})["data"]
    ver = next(v for v in vers if v["attributes"]["appStoreState"] in ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"))
    vid = ver["id"]
    if short and ver["attributes"]["versionString"] != short:
        r = req_soft("PATCH", f"/appStoreVersions/{vid}", json={"data": {"type": "appStoreVersions", "id": vid, "attributes": {"versionString": short}}})
        summary(f"- version string {ver['attributes']['versionString']} → {short}: HTTP {r.status_code} {'' if r.status_code < 300 else errs(r)}")
    r = req_soft("PATCH", f"/appStoreVersions/{vid}/relationships/build", json={"data": {"type": "builds", "id": build["id"]}})
    summary(f"- attach build: HTTP {r.status_code} {'' if r.status_code < 300 else errs(r)}")
    v = req("GET", f"/appStoreVersions/{vid}", params={"include": "build"})
    att = [x["attributes"]["version"] for x in v.get("included", []) if x["type"] == "builds"]
    summary(f"- version {v['data']['attributes']['versionString']} state **{v['data']['attributes']['appStoreState']}**, build attached: {att}")
    for i in get_all(f"/apps/{aid}/inAppPurchasesV2"):
        summary(f"  · IAP {i['attributes']['productId']}: {i['attributes'].get('state')}")
    for g in get_all(f"/apps/{aid}/subscriptionGroups"):
        for x in req("GET", f"/subscriptionGroups/{g['id']}/subscriptions")["data"]:
            summary(f"  · subscription {x['attributes']['productId']}: {x['attributes'].get('state')}")
    loc = req("GET", f"/appStoreVersions/{vid}/appStoreVersionLocalizations")["data"]
    for l in loc:
        sets = req("GET", f"/appStoreVersionLocalizations/{l['id']}/appScreenshotSets")["data"]
        parts = []
        for st in sets:
            n = len(req("GET", f"/appScreenshotSets/{st['id']}/appScreenshots")["data"])
            parts.append(f"{st['attributes']['screenshotDisplayType']}×{n}")
        summary(f"  · {l['attributes']['locale']} screenshots: {', '.join(parts)}")
    a = req("GET", f"/apps/{aid}")["data"]["attributes"]
    summary(f"  · contentRightsDeclaration: {a.get('contentRightsDeclaration')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
