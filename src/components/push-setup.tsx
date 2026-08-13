/**
 * Assigned-offer push setup (owner top priority 2026-08-12, design spec A4 —
 * copy verbatim; hard-fix + compliance 2026-08-13). Mounted in the driver
 * portal (RealDriverPortal):
 *
 *  1. On mount: preload the strike asset; if permission is ALREADY granted,
 *     ensure the service worker + subscription are registered (silent,
 *     idempotent — also covers a returning driver whose subscription was lost
 *     in a browser reset or whose endpoint changed).
 *  2. When Notification.permission === "default" AND the driver has not been
 *     asked 3 times (localStorage ld-notify-asked-v1), render the one-time
 *     "Allow notifications" card at the top of the Home sheet (spec A4:
 *     first contractor sign-in, post-login, on Home; NOT on the login screen —
 *     browser permission APIs need a user gesture anyway).
 *  3. Allow → requestPermission (user gesture) → subscribe (PushManager with
 *     the server's VAPID public key) → POST to the API → one confirmation
 *     strike (the rendered lightning-strike.mp3 asset) + success toast.
 *     Not now / denied → dismiss quietly; "Not now" re-asks up to 3 total.
 *
 * 2026-08-13 fix (owner-directed, root cause of 0 saved subscriptions): the
 * card NO LONGER hides itself when setup fails. Old behavior: permission
 * granted → ensurePushSubscription() returned false → setVisible(false) with
 * NO error and NO retry — a refused VAPID-key fetch, an SW registration
 * failure, or an iOS subscribe rejection all looked identical to success.
 * Now a failure keeps the card up with the exact driver-readable reason and a
 * Try again button; only a real success, a browser-level denial, or the
 * driver's own "Not now" hides it.
 *
 * 2026-08-13 (owner-hit, iOS): iPhone/iPad Safari exposes NO push APIs until
 * the site is added to the Home Screen, so this card used to hide itself on
 * iOS — a silent dead-end. On iOS (not installed) and in-app webviews the card
 * now renders the fix ("Add to Home Screen" walkthrough / "open in Safari or
 * Chrome") with an "I've done that — re-check" button that re-evaluates the
 * APIs without a reload and continues the normal allow flow when they appear.
 */
import { AlertTriangle, Bell, CheckCircle2, Info, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Card, useToast } from "~/components/ui";
import {
  asksRemaining,
  ensurePushSubscription,
  notificationSupportStatus,
  notificationsSupported,
  playStrikeAsset,
  preloadStrikeAsset,
  pushBrowserTruth,
  pushPermissionCopy,
  pushSetupFailureCopy,
  recordAsk,
  registerServiceWorker,
  type NotificationSupportStatus,
  type PushBrowserTruth,
  type PushSetupFailureReason,
} from "~/lib/push-client";
import { sendPushSelfTest } from "~/data/push";

/** The permission card itself — rendered by HomeSheet at the top of the peek
 *  area (spec A4 placement: above the primary job). */
export function PushPermissionCard() {
  const toast = useToast();
  // 2026-08-13 (owner-hit): iPhone/iPad Safari has NO push APIs until the site
  // is added to the Home Screen. Previously this card hid itself on iOS and
  // in-app browsers — a silent dead-end. Now it renders the guidance (Add to
  // Home Screen walkthrough / use Safari-Chrome) so the driver knows the fix.
  const [support, setSupport] = useState<NotificationSupportStatus>(() =>
    typeof window === "undefined" ? "unsupported" : notificationSupportStatus(),
  );
  const [visible, setVisible] = useState(() => {
    if (typeof window === "undefined") return false;
    if (support === "supported") return Notification.permission === "default" && asksRemaining() > 0;
    return support === "ios_not_installed" || support === "webview";
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ reason: PushSetupFailureReason; message: string } | null>(null);

  if (!visible) return null;

  const allow = async () => {
    setBusy(true);
    setFailure(null);
    recordAsk();
    try {
      const perm = await Notification.requestPermission();
      if (perm === "granted") {
        const result = await ensurePushSubscription();
        if (result.ok) {
          playStrikeAsset(); // one confirmation strike — "this is the sound"
          toast("Offers on — one strike means one new job. You can mute it anytime from the speaker icon.");
          setVisible(false);
          return;
        }
        // 2026-08-13: REAL failure — keep the card up with the reason + retry.
        setFailure({ reason: result.reason, message: pushSetupFailureCopy(result.reason) });
        return;
      }
      // 'denied' (or 'default' if the user dismissed the browser prompt):
      // stop asking permanently after a denial; a "default" still consumes an
      // ask (the cap keeps us honest). A denial is the browser's own state, so
      // the card hides — but the driver is told how to flip it back on.
      if (perm === "denied") {
        toast("Notifications are off in your browser settings — you can re-enable them there anytime.");
      }
      setVisible(false);
    } catch {
      setFailure({ reason: "subscribe_failed", message: pushSetupFailureCopy("subscribe_failed") });
    } finally {
      setBusy(false);
    }
  };

  /** "I've done that — re-check" (iOS): after the driver adds the site to the
   *  Home Screen and reopens it, the push APIs can appear without a reload —
   *  re-evaluate, then continue the normal allow flow when they do. */
  const recheck = async () => {
    setBusy(true);
    setFailure(null);
    const status = notificationSupportStatus();
    setSupport(status);
    if (status !== "supported") {
      setBusy(false);
      setFailure({
        reason: "subscribe_failed",
        message: "Still not available — make sure you opened Lightning Dispatch from the Home Screen icon (not Safari), then tap again.",
      });
      return;
    }
    await allow();
  };

  const notNow = () => {
    recordAsk();
    setVisible(false);
  };

  return (
    <Card className="mb-3 p-4" interactive>
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
          <Bell className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink-900">Get job offers the moment they're assigned</p>
          <p className="mt-1 text-xs leading-snug text-ink-500" aria-live="polite">
            Lightning Dispatch sends one alert per new job — the job type, location, and your ETA — with a single
            lightning strike. You'll hear it, see it, and be ready before the owner even calls.
          </p>
        </div>
      </div>
      {support !== "supported" && !failure && (
        <div className="mt-3 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2.5" role="status">
          {support === "ios_not_installed" ? (
            <p className="text-xs leading-relaxed text-ink-700">
              <b>First add Lightning Dispatch to your Home Screen:</b> tap <b>Share</b> (the square with an up arrow at the
              bottom of Safari) → <b>Add to Home Screen</b> → open <b>Lightning Dispatch</b> from your home screen, then
              come back and tap <b>Allow</b>.
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-ink-700">
              Open this page in <b>Safari or Chrome</b> — in-app browsers (like the ones inside Facebook, Instagram, or
              iMessage) can&apos;t receive job alerts.
            </p>
          )}
        </div>
      )}
      {failure && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-danger-200 bg-danger-50 px-3 py-2.5" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger-500" aria-hidden="true" />
          <p className="text-xs leading-relaxed text-danger-800">{failure.message}</p>
        </div>
      )}
      <div className="mt-3 space-y-2">
        {support === "ios_not_installed" ? (
          <Button variant="primary" size="md" className="h-11 w-full" loading={busy} onClick={() => void recheck()}>
            I've done that — re-check
          </Button>
        ) : support === "supported" ? (
          <Button variant="primary" size="md" className="h-11 w-full" loading={busy} onClick={() => void allow()}>
            {failure ? "Try again" : "Allow notifications"}
          </Button>
        ) : null}
        <Button variant="ghost" size="md" className="h-10 w-full" disabled={busy} onClick={notNow}>
          Not now
        </Button>
      </div>
      {/* Browser truth + one-tap end-to-end self-test (owner-directed
          2026-08-13): shows granted/denied/default + push service availability
          and sends a real test push to THIS device. */}
      <PushSelfTestPanel />
    </Card>
  );
}

/**
 * Mounted once in the driver portal. Registers the service worker on login,
 * preloads the strike asset, and silently re-registers the subscription when
 * permission is already granted (returning drivers). Renders nothing itself —
 * the card is rendered by HomeSheet via <PushPermissionCard />.
 */
export function PushNotificationSetup() {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    preloadStrikeAsset();
    if (!notificationsSupported()) return;
    const boot = async () => {
      if (Notification.permission === "granted") {
        await ensurePushSubscription();
      } else if (Notification.permission === "default") {
        // Register the SW early so a later Allow has no registration latency.
        await registerServiceWorker();
      }
    };
    void boot();
  }, []);
  return null;
}

/**
 * "Send test notification" + browser-truth readout (owner-directed 2026-08-13).
 * Rendered on the driver's Notifications card (Home push card + the Documents
 * "Notifications & Location" sheet — and therefore the owner's driver-view copy
 * of both). Shows the REAL phone-side state so a driver with notifications off
 * in browser/OS settings sees "Browser permission: denied" instead of silent
 * failure, and lets them verify end-to-end delivery with one tap.
 */
export function PushSelfTestPanel() {
  const [truth, setTruth] = useState<PushBrowserTruth>(() =>
    typeof window === "undefined"
      ? { permission: "unsupported", pushManager: false, serviceWorker: false }
      : pushBrowserTruth(),
  );
  // Re-read when the tab regains focus — permission changes land in Settings.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const re = () => setTruth(pushBrowserTruth());
    window.addEventListener("focus", re);
    return () => window.removeEventListener("focus", re);
  }, []);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

  const send = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const r = await sendPushSelfTest();
      if (!r.ok) {
        setOutcome({ tone: "err", text: "Couldn't send the test — sign in again and retry." });
        return;
      }
      const d = r.data;
      if (d.sent > 0) {
        setOutcome({
          tone: "ok",
          text: `Sent ✓ — check this phone's notifications for the Lightning Dispatch test banner.`,
        });
      } else if (d.reason === "no_subscriptions") {
        setOutcome({ tone: "warn", text: "No subscription on this device — allow notifications first, then send again." });
      } else if (d.reason && d.reason.startsWith("Only contractors")) {
        setOutcome({ tone: "warn", text: "This account can't send test alerts on this device." });
      } else if (d.failed > 0) {
        setOutcome({
          tone: "err",
          text: "The test didn't reach this device — make sure notifications are allowed in Settings, then try again.",
        });
      } else if (d.reason) {
        setOutcome({ tone: "warn", text: d.reason });
      } else {
        setOutcome({ tone: "err", text: "The test didn't reach this device — try again in a moment." });
      }
    } catch {
      setOutcome({ tone: "err", text: "Couldn't reach the alert service — check your connection and try again." });
    } finally {
      setBusy(false);
    }
  };

  const pushReady = truth.pushManager && truth.serviceWorker;
  const tone =
    truth.permission === "granted" ? "bg-success-50 text-success-700" :
    truth.permission === "denied" ? "bg-danger-50 text-danger-700" :
    "bg-ink-50 text-ink-600";

  return (
    <div className="mt-3 rounded-xl border border-ink-100 bg-surface p-3">
      <p className="text-xs font-bold text-ink-800">Test notifications on this phone</p>
      <p className={`mt-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold leading-relaxed ${tone}`}>
        {pushPermissionCopy(truth.permission)}
        {truth.permission !== "unsupported" && (
          <span className="font-normal text-ink-500">
            {" · "}
            {pushReady ? "alert service ready" : "alert service not available on this browser"}
          </span>
        )}
      </p>
      <Button
        variant="secondary"
        size="md"
        className="mt-2.5 h-11 w-full"
        loading={busy}
        onClick={() => void send()}
      >
        <Send className="size-4" aria-hidden="true" /> Send test notification
      </Button>
      {outcome && (
        <p
          role="status"
          aria-live="polite"
          className={`mt-2 flex items-start gap-1.5 text-[11px] font-medium leading-relaxed ${
            outcome.tone === "ok" ? "text-success-700" : outcome.tone === "warn" ? "text-accent-800" : "text-danger-700"
          }`}
        >
          {outcome.tone === "ok" ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <Info className="mt-0.5 size-3.5 shrink-0" />}
          {outcome.text}
        </p>
      )}
    </div>
  );
}
