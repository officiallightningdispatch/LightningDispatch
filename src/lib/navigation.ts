/**
 * Navigation helpers — driver-portal feature batch 6 (owner-directed
 * 2026-08-12): the "navigate to customer" action opens IN-APP NAVIGATION as
 * the DEFAULT (the platform's native map/URL scheme), with Google Maps /
 * Apple Maps / Waze as explicit options in a small sheet/menu.
 *
 * Pure client-safe helpers (no server imports) so the menu logic is unit-
 * testable: buildNavOptions takes an explicit userAgent so tests pin the
 * platform.
 *
 * Scheme choices:
 *  - iOS/macOS default  → Apple Maps   https://maps.apple.com/?daddr=lat,lng
 *    (the native maps app; no app needed, opens in-app navigation)
 *  - Android/other      → geo: scheme  geo:lat,lng?q=lat,lng (opens the
 *    default maps app — Google Maps on virtually every Android)
 *  - Explicit options: Google Maps directions URL, Apple Maps URL, Waze URL.
 */

export type NavOption = {
  id: string;
  label: string;
  sub: string;
  url: string;
  /** The platform-native default — visually the primary action in the menu. */
  default?: boolean;
};

export const isIOSUA = (ua: string): boolean => /iphone|ipad|ipod/i.test(ua);

const googleMapsUrl = (lat: number, lng: number): string =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
const appleMapsUrl = (lat: number, lng: number): string =>
  `https://maps.apple.com/?daddr=${lat},${lng}`;
const geoUrl = (lat: number, lng: number): string =>
  `geo:${lat},${lng}?q=${lat},${lng}`;
const wazeUrl = (lat: number, lng: number): string =>
  `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;

/** The full option set for a pickup coordinate: [default, google, apple,
 *  waze]. The default is FIRST and marked default — the sheet renders it as
 *  the prominent primary action, the others as explicit rows. */
export function buildNavOptions(lat: number, lng: number, ua: string): NavOption[] {
  const defaultOption: NavOption = isIOSUA(ua)
    ? { id: "apple-default", label: "Start navigation", sub: "Apple Maps — turn-by-turn", url: appleMapsUrl(lat, lng), default: true }
    : { id: "geo-default", label: "Start navigation", sub: "Your maps app — turn-by-turn", url: geoUrl(lat, lng), default: true };
  return [
    defaultOption,
    { id: "google", label: "Google Maps", sub: "Directions in Google Maps", url: googleMapsUrl(lat, lng) },
    { id: "apple", label: "Apple Maps", sub: "Directions in Apple Maps", url: appleMapsUrl(lat, lng) },
    { id: "waze", label: "Waze", sub: "Navigate in Waze", url: wazeUrl(lat, lng) },
  ];
}

/** Pick the platform's native default URL (what "open navigation" jumps to
 *  immediately when the caller wants one-tap behavior). */
export function defaultNavUrl(lat: number, lng: number, ua: string): string {
  return isIOSUA(ua) ? appleMapsUrl(lat, lng) : geoUrl(lat, lng);
}
