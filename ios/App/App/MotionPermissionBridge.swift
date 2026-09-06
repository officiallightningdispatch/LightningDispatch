import Foundation
import CoreMotion
import WebKit

/// Minimal native bridge that triggers the iOS "Motion & Fitness" permission
/// prompt. That prompt is fired by CoreMotion *activity/step* access
/// (`CMMotionActivityManager` / `CMPedometer`), NOT by `CMMotionManager`
/// accelerometer — which is why the web-only `@capacitor/motion` plugin (which
/// ships no native source and falls back to `DeviceMotionEvent`) never fired it.
///
/// Exposed to JS as `window.webkit.messageHandlers.ldMotionPermission.postMessage({ requestId })`.
/// The result is delivered back to the page via
/// `window.__ldMotionPermissionCallback(requestId, status)` because a
/// WKScriptMessageHandler is fire-and-forget (no return value). This is a
/// fail-closed enhancement: a missing handler or a read error NEVER blocks the
/// GPS pipeline — the caller treats anything other than "granted" as no-op.
final class MotionPermissionBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "ldMotionPermission"

    private weak var webView: WKWebView?
    private let activityManager = CMMotionActivityManager()

    init(webView: WKWebView) {
        self.webView = webView
        super.init()
        webView.configuration.userContentController.add(self, name: Self.handlerName)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard
            message.name == Self.handlerName,
            let body = message.body as? [String: Any],
            let requestId = body["requestId"] as? String
        else { return }

        requestMotionPermission { [weak self] status in
            self?.deliver(status: status, requestId: requestId)
        }
    }

    /// Touches CoreMotion activity access once, which triggers the OS "Motion &
    /// Fitness" prompt on first use. The completion handler runs after the user
    /// responds (or immediately when the state is already resolved).
    private func requestMotionPermission(completion: @escaping (String) -> Void) {
        guard CMMotionActivityManager.isActivityAvailable() else {
            completion("unavailable")
            return
        }
        let now = Date()
        // An empty one-instant query is enough to fire the prompt; we do not
        // actually consume activity data (the accelerometer-triggered GPS path
        // stays on the existing plugin / DeviceMotionEvent route).
        activityManager.queryActivityStarting(from: now, to: now, to: .main) { _, error in
            if let error = error {
                // CMErrorMotionActivityNotAuthorized (103) = user denied (or
                // permission already off in Settings). Anything else is an
                // availability/entitlement problem — still not "granted".
                completion((error as NSError).code == 103 ? "denied" : "unavailable")
            } else {
                completion("granted")
            }
        }
    }

    private func deliver(status: String, requestId: String) {
        guard let webView = webView else { return }
        let js = "window.__ldMotionPermissionCallback && window.__ldMotionPermissionCallback('\(requestId)', '\(status)');"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }
}
