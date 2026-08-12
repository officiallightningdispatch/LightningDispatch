/**
 * Assigned-offer push setup (owner top priority 2026-08-12, design spec A4 —
 * copy verbatim). Mounted in the driver portal (RealDriverPortal):
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
 * Never blocks the portal: every failure is silent, the in-app banner +
 * WebAudio strike (sound.ts) work regardless.
 */
import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Card, useToast } from "~/components/ui";
import {
  asksRemaining,
  ensurePushSubscription,
  notificationsSupported,
  playStrikeAsset,
  preloadStrikeAsset,
  recordAsk,
  registerServiceWorker,
} from "~/lib/push-client";

/** The permission card itself — rendered by HomeSheet at the top of the peek
 *  area (spec A4 placement: above the primary job). */
export function PushPermissionCard() {
  const toast = useToast();
  const [visible, setVisible] = useState(() => {
    if (typeof window === "undefined" || !notificationsSupported()) return false;
    return Notification.permission === "default" && asksRemaining() > 0;
  });
  const [busy, setBusy] = useState(false);

  if (!visible) return null;

  const allow = async () => {
    setBusy(true);
    recordAsk();
    try {
      const perm = await Notification.requestPermission();
      if (perm === "granted") {
        const ok = await ensurePushSubscription();
        if (ok) {
          playStrikeAsset(); // one confirmation strike — "this is the sound"
          toast("Offers on — one strike means one new job. You can mute it anytime from the speaker icon.");
        }
        setVisible(false);
        return;
      }
      // 'denied' (or 'default' if the user dismissed the browser prompt):
      // stop asking permanently after a denial; a "default" still consumes an
      // ask (the cap keeps us honest).
      setVisible(false);
    } catch {
      setVisible(false);
    } finally {
      setBusy(false);
    }
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
      <div className="mt-3 space-y-2">
        <Button variant="primary" size="md" className="h-11 w-full" loading={busy} onClick={() => void allow()}>
          Allow notifications
        </Button>
        <Button variant="ghost" size="md" className="h-9 w-full" disabled={busy} onClick={notNow}>
          Not now
        </Button>
      </div>
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
