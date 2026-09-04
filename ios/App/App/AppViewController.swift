import UIKit
import Capacitor

/// App Store submission blocker (owner item 2): WKWebView pinch-zoom could
/// zoom IN but would not zoom back OUT, leaving the app stuck half-zoomed with
/// no recovery. Capacitor disables zooming by setting the webview's scroll
/// view delegate and disabling its pinch recognizer only in
/// `scrollViewWillBeginZooming` — i.e. AFTER the first zoom gesture has
/// already begun. That late-disable is what produces the one-way dead-end.
///
/// We make the behavior deterministic by disabling the pinch recognizer up
/// front, before the page ever loads, so pinch-zoom is fully OFF rather than
/// half-on. This keeps the gesture idempotent in both directions and removes
/// the stuck-zoomed state the owner saw on TestFlight.
final class AppViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // Runs after `webView` is set but before the page is loaded. Disabling
        // the recognizer here (instead of relying on Capacitor's
        // scrollViewWillBeginZooming callback) means a pinch never zooms at all.
        webView?.scrollView.pinchGestureRecognizer?.isEnabled = false
    }
}
