import { captureScreenshot, pageConnection } from "./browser-session.js";
import { browserStartupTimeoutMs, launchChrome } from "./chrome-transport.js";

/** Only a new blank target: no project navigation, evidence, download, or user browser. */
export async function probeBrowserCapability(): Promise<void> {
  const transport = await launchChrome({
    startupTimeoutMs: browserStartupTimeoutMs(),
    operationTimeoutMs: 2000,
  });
  try {
    const send = await pageConnection(transport);
    await send("Emulation.setDeviceMetricsOverride", {
      width: 320,
      height: 240,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await captureScreenshot(send);
  } finally {
    // The existing transport bounds shutdown and removes its isolated profile.
    await transport.close();
  }
}
