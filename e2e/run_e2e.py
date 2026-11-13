"""End-to-end test: drives the real app in headless Chromium and saves screenshots.
Usage: python3 e2e/run_e2e.py [base_url]   (server must already be running)"""
import sys, re, os
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4100"
OUT = os.path.join(os.path.dirname(__file__), "..", "screenshots")
os.makedirs(OUT, exist_ok=True)
results = []

def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS  " if cond else "FAIL  ") + name)
    if not cond:
        raise AssertionError(name)

def shot(page, name, full=False):
    if full:  # the composer is sticky in real use; un-stick it so full-page captures are not overlapped
        page.add_style_tag(content=".composer{position:static!important;background:none!important}")
    page.screenshot(path=os.path.join(OUT, name + ".png"), full_page=full)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, timezone_id="Asia/Kolkata", locale="en-US")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "401" not in m.text and "409" not in m.text else None)

    # 1. sign-in screen + failed login
    page.goto(BASE)
    expect(page.get_by_role("heading", name="Say when. We find the time.")).to_be_visible()
    shot(page, "01-login")
    page.get_by_label("Email").fill("nobody@example.com")
    page.get_by_label("Password").fill("wrongpassword")
    page.get_by_role("button", name="Sign in").click()
    expect(page.get_by_role("alert")).to_contain_text("incorrect")
    shot(page, "02-login-error")
    check("login with bad credentials shows an error", True)

    # 2. register
    page.get_by_role("button", name="New here? Create an account").click()
    page.get_by_label("Full name").fill("Dana Rao")
    page.get_by_label("Email").fill("dana@example.com")
    page.get_by_label("Password").fill("correct-horse-battery")
    shot(page, "03-register")
    page.get_by_role("button", name="Create account").click()
    expect(page.get_by_text("What should we schedule?")).to_be_visible()
    check("registration signs the user in", True)

    # 3. calendar not connected yet
    expect(page.get_by_text("Connect Google Calendar so the assistant can check availability.")).to_be_visible()
    shot(page, "04-assistant-calendar-disconnected")
    page.locator("button.status-pill.off").click()
    expect(page.get_by_text("Calendar connected")).to_be_visible()
    check("connecting Google Calendar updates the status", True)
    shot(page, "05-assistant-ready")

    # 4. natural-language request -> three slots
    page.get_by_label("Scheduling request").fill("Find 45 minutes next week for me, Sarah, and Alex after 2 PM. Avoid Friday.")
    page.get_by_role("button", name="Find a time").click()
    page.wait_for_selector(".slot")
    n = page.locator(".slot").count()
    check("assistant recommends 1-3 slots", 1 <= n <= 3)
    expect(page.get_by_text("45 min").first).to_be_visible()
    chips = page.locator(".summary .chip").all_inner_texts()
    check("request summary shows duration, after 14:00 and 'not Fri'", "45 min" in chips and "after 14:00" in chips and "not Fri" in chips)
    check("participants Sarah Chen and Alex Rivera were resolved", "Sarah Chen" in chips and "Alex Rivera" in chips)
    times = page.locator(".slot .time").all_inner_texts()
    check("every slot starts at or after 2:00 PM", all(re.match(r"^(\d{1,2}):\d{2} PM", t) and (int(t.split(':')[0]) == 12 or int(t.split(':')[0]) >= 2) or t.startswith(("2:", "3:", "4:", "5:")) for t in times))
    check("no slot falls on Friday", not any("Fri" in d for d in page.locator(".slot h3").all_inner_texts()))
    check("each slot has an explanation and a timeline", page.locator(".slot .why").count() == n and page.locator(".slot .timeline").count() == n)
    check("participant-local times are shown for other time zones", page.locator(".slot .locals").count() >= 1)
    shot(page, "06-recommended-slots", full=True)

    # 5. choose slot -> invitation preview (nothing sent yet)
    page.locator(".slot").first.get_by_role("button", name="Choose this time").click()
    expect(page.get_by_role("heading", name="Review the invitation")).to_be_visible()
    check("no invitation is sent before confirmation", page.get_by_text("Invitation sent").count() == 0)
    page.get_by_label("Title").fill("Roadmap sync")
    page.get_by_label("Add a Google Meet link").check()
    shot(page, "07-invitation-preview", full=True)

    # 6. confirm -> success
    page.get_by_role("button", name="Confirm and send invitation").click()
    expect(page.get_by_role("heading", name="Invitation sent")).to_be_visible()
    check("confirmation creates the calendar event", page.get_by_role("link", name="Open in Google Calendar").count() == 1)
    check("Google Meet link was generated", page.get_by_role("link", name="Join with Google Meet").count() == 1)
    shot(page, "08-invitation-sent", full=True)

    # 7. clarification flow for incomplete request
    page.get_by_label("Scheduling request").fill("Schedule a meeting with Maya.")
    page.get_by_role("button", name="Find a time").click()
    expect(page.get_by_text("How long should the meeting be?")).to_be_visible()
    expect(page.get_by_text("Which dates should I look at?")).to_be_visible()
    expect(page.get_by_text("I don't have Maya saved yet.")).to_be_visible()
    check("assistant asks clarification questions for missing info", page.get_by_role("button", name="Continue").is_disabled())
    shot(page, "09-clarification", full=True)
    page.get_by_role("button", name="30 min").click()
    page.get_by_role("button", name="Next week").click()
    page.get_by_label("Email for Maya").fill("maya@example.com")
    page.get_by_role("button", name="Continue").click()
    page.wait_for_function("document.querySelectorAll('.slot').length >= 2 && document.querySelectorAll('.summary').length >= 2")
    check("answering clarifications produces slots", page.locator(".summary").count() == 2)

    # 8. dashboard
    page.get_by_role("button", name="Dashboard", exact=True).click()
    expect(page.get_by_role("heading", name="Scheduling history")).to_be_visible()
    page.wait_for_selector(".events li")
    check("dashboard shows profile, calendar status, history", page.get_by_text("dana@example.com").count() >= 1 and page.get_by_text("Booked").count() >= 1)
    check("dashboard lists the newly created meeting", page.get_by_text("Roadmap sync").count() >= 1)
    shot(page, "10-dashboard", full=True)

    # 9. participants
    page.get_by_role("button", name="Participants", exact=True).click()
    expect(page.get_by_role("heading", name="Saved participants")).to_be_visible()
    page.get_by_label("Name").fill("Sarah Chen 2")
    page.get_by_label("Email", exact=True).fill("sarah@example.com")
    page.get_by_role("button", name="Save participant").click()
    expect(page.get_by_role("alert")).to_contain_text("already saved")
    check("duplicate participant email is rejected", True)
    page.get_by_label("Search participants").fill("maya")
    page.wait_for_function("document.querySelectorAll('.plist li').length === 1")
    check("participant search filters the list", True)
    page.get_by_label("Search participants").fill("")
    shot(page, "11-participants", full=True)

    # 10. disconnect + sign out
    page.get_by_role("button", name="Dashboard", exact=True).click()
    page.get_by_role("button", name="Disconnect Google Calendar").click()
    expect(page.get_by_text("Not connected")).to_be_visible()
    page.get_by_role("button", name="Assistant", exact=True).click()
    page.get_by_label("Scheduling request").fill("30 minutes next week with Sarah")
    page.get_by_role("button", name="Find a time").click()
    expect(page.locator(".bubble.error")).to_contain_text("Connect Google Calendar")
    shot(page, "12-calendar-disconnected-error", full=True)
    check("scheduling is blocked while Google Calendar is disconnected", True)
    page.get_by_role("button", name="Sign out").click()
    expect(page.get_by_role("heading", name="Say when. We find the time.")).to_be_visible()
    check("sign out returns to the login screen", True)

    # 11. mobile
    m = browser.new_context(viewport={"width": 390, "height": 844}, timezone_id="Asia/Kolkata", device_scale_factor=2)
    mp = m.new_page()
    mp.goto(BASE)
    mp.get_by_role("button", name="New here? Create an account").click()
    mp.get_by_label("Full name").fill("Mobile User")
    mp.get_by_label("Email").fill("mobile@example.com")
    mp.get_by_label("Password").fill("correct-horse-battery")
    mp.get_by_role("button", name="Create account").click()
    mp.locator("button.status-pill.off").click()
    mp.get_by_label("Scheduling request").fill("Arrange a 30-minute meeting with John and Priya next Tuesday.")
    mp.get_by_role("button", name="Find a time").click()
    mp.wait_for_selector(".slot")
    check("layout has no horizontal overflow on mobile", mp.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
    mp.screenshot(path=os.path.join(OUT, "13-mobile-slots.png"), full_page=True)

    check("no unexpected browser console/page errors", not errors)
    browser.close()

print(f"\n{sum(ok for _, ok in results)}/{len(results)} end-to-end checks passed")
