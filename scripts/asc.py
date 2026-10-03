#!/usr/bin/env python3
"""App Store Connect helper for CI (API key auth, same key the other DART apps use).

  asc.py provision   ensure bundle id + Sign in with Apple capability + app record,
                     create a fresh IOS_APP_STORE profile for the CI certificate
                     → $OUT/profile.mobileprovision, $OUT/uuid.txt, $OUT/name.txt
  asc.py wait BUILD  wait until build BUILD finishes processing and is installable
                     in TestFlight (internal testing); adds it to internal groups

Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH, BUNDLE_ID, [CERTIFICATE_BASE64,
CERTIFICATE_PASSWORD], [OUT]
"""
import base64, json, os, subprocess, sys, tempfile, time
from pathlib import Path

import jwt, requests

API = "https://api.appstoreconnect.apple.com/v1"
KEY_ID = os.environ.get("ASC_KEY_ID", "NQXQ595W59")
ISSUER = os.environ["ASC_ISSUER_ID"]
KEY_PATH = os.environ["ASC_KEY_PATH"]
BUNDLE = os.environ.get("BUNDLE_ID", "com.dartmeadow.jots")
APP_NAME = os.environ.get("APP_NAME", "DART Meadow")
PROFILE_NAME = os.environ.get("PROFILE_NAME", "DartMeadow JOTS AppStore CI")
OUT = Path(os.environ.get("OUT", "/tmp/asc"))
OUT.mkdir(parents=True, exist_ok=True)
SUMMARY = os.environ.get("GITHUB_STEP_SUMMARY")


def summary(line):
    print(line)
    if SUMMARY:
        with open(SUMMARY, "a") as f:
            f.write(line + "\n")


_tok = {"t": None, "exp": 0}


def token():
    if time.time() > _tok["exp"] - 60:
        now = int(time.time())
        _tok["t"] = jwt.encode({"iss": ISSUER, "iat": now, "exp": now + 1150, "aud": "appstoreconnect-v1"},
                               Path(KEY_PATH).read_text(), algorithm="ES256",
                               headers={"kid": KEY_ID, "typ": "JWT"})
        _tok["exp"] = now + 1150
    return _tok["t"]


def req(method, path, ok=(200, 201, 204), **kw):
    url = path if path.startswith("http") else API + path
    r = requests.request(method, url, headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"},
                         timeout=90, **kw)
    print(f"{method} {url.replace(API, '')} -> {r.status_code}")
    if r.status_code not in ok:
        print(r.text[:2500])
        r.raise_for_status()
    return r.json() if r.content else None


def get_all(path, params=None):
    params = dict(params or {}); params.setdefault("limit", 200)
    page = req("GET", path, params=params); data = list(page.get("data") or [])
    while page.get("links", {}).get("next"):
        page = req("GET", page["links"]["next"]); data += page.get("data") or []
    return data


# ── provisioning ─────────────────────────────────────────────────────────
def ensure_bundle():
    found = [b for b in get_all("/bundleIds", {"filter[identifier]": BUNDLE}) if b["attributes"]["identifier"] == BUNDLE]
    if found:
        b = found[0]; summary(f"- bundle id `{BUNDLE}` exists ({b['id']})")
    else:
        b = req("POST", "/bundleIds", json={"data": {"type": "bundleIds", "attributes": {
            "identifier": BUNDLE, "name": "DART Meadow JOTS", "platform": "IOS"}}})["data"]
        summary(f"- bundle id `{BUNDLE}` registered ({b['id']})")
    caps = req("GET", f"/bundleIds/{b['id']}/bundleIdCapabilities").get("data") or []
    if any(c["attributes"].get("capabilityType") == "APPLE_ID_AUTH" for c in caps):
        summary("- Sign in with Apple capability: enabled")
    else:
        req("POST", "/bundleIdCapabilities", json={"data": {"type": "bundleIdCapabilities", "attributes": {
            "capabilityType": "APPLE_ID_AUTH",
            "settings": [{"key": "APPLE_ID_AUTH_APP_CONSENT", "options": [{"key": "PRIMARY_APP_CONSENT"}]}]},
            "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": b["id"]}}}}})
        summary("- Sign in with Apple capability: enabled now")
    return b


def find_app():
    apps = get_all("/apps", {"filter[bundleId]": BUNDLE})
    apps = [a for a in apps if a["attributes"].get("bundleId") == BUNDLE]
    return apps[0] if apps else None


def p12_fingerprints():
    b64 = os.environ.get("CERTIFICATE_BASE64", "").strip()
    if not b64:
        return set()
    pw = os.environ.get("CERTIFICATE_PASSWORD", "")
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "c.p12"; p.write_bytes(base64.b64decode(b64))
        pem = b""
        for extra in ([], ["-legacy"]):
            try:
                pem = subprocess.check_output(["openssl", "pkcs12", *extra, "-in", str(p), "-passin", f"pass:{pw}",
                                               "-nokeys", "-clcerts"], stderr=subprocess.DEVNULL)
                break
            except subprocess.CalledProcessError:
                continue
        fps = set()
        for chunk in pem.split(b"-----BEGIN CERTIFICATE-----")[1:]:
            c = Path(td) / "x.pem"
            c.write_bytes(b"-----BEGIN CERTIFICATE-----" + chunk.split(b"-----END CERTIFICATE-----")[0] + b"-----END CERTIFICATE-----\n")
            out = subprocess.check_output(["openssl", "x509", "-in", str(c), "-noout", "-fingerprint", "-sha1"]).decode()
            fps.add(out.split("=", 1)[1].strip().replace(":", "").upper())
        return fps


def pick_cert():
    certs = [c for c in get_all("/certificates")
             if c["attributes"].get("certificateType") in ("IOS_DISTRIBUTION", "DISTRIBUTION", "APPLE_DISTRIBUTION")]
    if not certs:
        raise SystemExit("FATAL: no distribution certificate on the team")
    fps = p12_fingerprints()
    for c in certs:
        content = c["attributes"].get("certificateContent")
        if not content:
            continue
        with tempfile.NamedTemporaryFile(suffix=".cer") as f:
            f.write(base64.b64decode(content)); f.flush()
            fp = subprocess.check_output(["openssl", "x509", "-inform", "DER", "-in", f.name, "-noout",
                                          "-fingerprint", "-sha1"]).decode().split("=", 1)[1].strip().replace(":", "").upper()
        if fp in fps:
            summary(f"- signing certificate: {c['attributes'].get('name')} {c['id']} (matches CERTIFICATE_BASE64)")
            return c["id"]
    certs.sort(key=lambda c: c["attributes"].get("expirationDate") or "", reverse=True)
    summary(f"- WARNING: no ASC certificate matched CERTIFICATE_BASE64; using newest {certs[0]['id']}")
    return certs[0]["id"]


def provision():
    summary("### App Store Connect provisioning")
    b = ensure_bundle()
    app = find_app()
    cert = pick_cert()
    for p in get_all("/profiles", {"filter[name]": PROFILE_NAME}):
        if p["attributes"].get("name") == PROFILE_NAME:
            req("DELETE", f"/profiles/{p['id']}")
    prof = req("POST", "/profiles", json={"data": {"type": "profiles",
        "attributes": {"name": PROFILE_NAME, "profileType": "IOS_APP_STORE"},
        "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": b["id"]}},
                          "certificates": {"data": [{"type": "certificates", "id": cert}]}}}})["data"]
    raw = base64.b64decode(prof["attributes"]["profileContent"])
    (OUT / "profile.mobileprovision").write_bytes(raw)
    (OUT / "uuid.txt").write_text(prof["attributes"]["uuid"])
    (OUT / "name.txt").write_text(PROFILE_NAME)
    has_siwa = b"com.apple.developer.applesignin" in raw
    summary(f"- profile `{PROFILE_NAME}` uuid {prof['attributes']['uuid']} · Sign in with Apple in profile: {has_siwa}")
    if not has_siwa:
        raise SystemExit("FATAL: provisioning profile lacks com.apple.developer.applesignin")
    if not app:
        try:
            for a in get_all("/apps", {"fields[apps]": "name,bundleId"}):
                summary(f"  - existing app record: {a['attributes'].get('name')} · `{a['attributes'].get('bundleId')}`")
        except Exception as e:
            print("could not list apps:", e)
        summary(f"- **BLOCKER:** no App Store Connect app record for `{BUNDLE}`. Create it once in App Store Connect → "
                f"Apps → + → New App (iOS, name \"{APP_NAME}\", bundle ID {BUNDLE}, SKU dartmeadow-jots), then re-run.")
        (OUT / "app_missing").write_text("1")
        return 3
    (OUT / "app_id.txt").write_text(app["id"])
    summary(f"- app record: {app['attributes'].get('name')} ({app['id']})")
    return 0


# ── TestFlight readiness ────────────────────────────────────────────────
def wait(build_number, minutes=75):
    app = find_app()
    if not app:
        raise SystemExit("FATAL: no app record")
    summary(f"### TestFlight processing for build {build_number}")
    deadline = time.time() + minutes * 60
    build = None
    while time.time() < deadline:
        builds = req("GET", "/builds", params={"filter[app]": app["id"], "filter[version]": build_number,
                                                "include": "buildBetaDetail", "limit": 5})
        if builds.get("data"):
            build = builds["data"][0]
            st = build["attributes"].get("processingState")
            detail = next((i for i in builds.get("included", []) if i["type"] == "buildBetaDetails"), None)
            internal = detail["attributes"].get("internalBuildState") if detail else None
            print(f"processingState={st} internalBuildState={internal}")
            if st in ("FAILED", "INVALID"):
                summary(f"- build {build_number}: processing {st}")
                return 2
            if st == "VALID":
                if build["attributes"].get("usesNonExemptEncryption") is None or internal == "MISSING_EXPORT_COMPLIANCE":
                    req("PATCH", f"/builds/{build['id']}", json={"data": {"type": "builds", "id": build["id"],
                        "attributes": {"usesNonExemptEncryption": False}}})
                if internal in ("READY_FOR_BETA_TESTING", "IN_BETA_TESTING"):
                    add_to_internal_groups(app["id"], build["id"])
                    summary(f"- ✅ build {build_number} is **installable in TestFlight** (internal: {internal})")
                    (OUT / "installable").write_text(build_number)
                    return 0
        else:
            print("build not visible in App Store Connect yet")
        time.sleep(45)
    summary(f"- build {build_number}: still processing after {minutes} min")
    return 4


def add_to_internal_groups(app_id, build_id):
    try:
        groups = [g for g in get_all(f"/apps/{app_id}/betaGroups") if g["attributes"].get("isInternalGroup")]
        if not groups:
            g = req("POST", "/betaGroups", ok=(201,), json={"data": {"type": "betaGroups",
                "attributes": {"name": "DART Meadow Crew", "isInternalGroup": True, "hasAccessToAllBuilds": True},
                "relationships": {"app": {"data": {"type": "apps", "id": app_id}}}}})["data"]
            groups = [g]
            summary("- created internal TestFlight group \"DART Meadow Crew\" (all builds)")
        # the internal testers the team's other apps use (e.g. Autumn AI, Ash Tree IDE)
        wanted = {}
        for other in get_all("/apps", {"fields[apps]": "name,bundleId"}):
            if other["id"] == app_id:
                continue
            try:
                for og in get_all(f"/apps/{other['id']}/betaGroups"):
                    if og["attributes"].get("isInternalGroup"):
                        for t in get_all(f"/betaGroups/{og['id']}/betaTesters"):
                            wanted[t["id"]] = t["attributes"].get("email") or t["id"]
            except Exception as e:
                print("skip", other["attributes"].get("name"), e)
        for g in groups:
            if not g["attributes"].get("hasAccessToAllBuilds"):
                req("POST", f"/betaGroups/{g['id']}/relationships/builds", ok=(204, 409),
                    json={"data": [{"type": "builds", "id": build_id}]})
            have = {t["id"] for t in get_all(f"/betaGroups/{g['id']}/betaTesters")}
            missing = [i for i in wanted if i not in have]
            if missing:
                req("POST", f"/betaGroups/{g['id']}/relationships/betaTesters", ok=(204, 409, 422),
                    json={"data": [{"type": "betaTesters", "id": i} for i in missing]})
            testers = get_all(f"/betaGroups/{g['id']}/betaTesters")
            summary(f"- internal group \"{g['attributes'].get('name')}\": {len(testers)} tester(s): "
                    + ", ".join(sorted(t["attributes"].get("email") or "?" for t in testers)))
    except Exception as e:  # never fail the run over group bookkeeping
        summary(f"- note: couldn't update internal groups ({e})")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "provision":
        sys.exit(provision())
    if cmd == "wait":
        sys.exit(wait(sys.argv[2]))
    print(__doc__); sys.exit(1)
