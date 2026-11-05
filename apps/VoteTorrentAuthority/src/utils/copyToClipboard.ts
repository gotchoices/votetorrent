import { Platform } from "react-native";
import Clipboard from "@react-native-clipboard/clipboard";

/**
 * Writes `text` to the clipboard and resolves `true` only when the copy is known to have landed.
 *
 * On Android it READS THE CLIPBOARD BACK. The Android native `setString` swallows its own
 * exceptions (`ClipboardModule.setString` only `printStackTrace`s, and it is a void TurboModule
 * method, so JS never sees a failure). A silent failure is otherwise indistinguishable from
 * success, which is what the Redmi 8 showed (UAT 62): an empty clipboard and no feedback. iOS skips
 * the read-back: UIPasteboard writes do not fail silently, and a programmatic read raises the
 * iOS 16+ "Allow Paste" prompt on every Copy.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
	try {
		Clipboard.setString(text);
		return Platform.OS === "android" ? (await Clipboard.getString()) === text : true;
	} catch (error) {
		console.warn("copyToClipboard: clipboard copy failed:", error instanceof Error ? error.name : typeof error);
		return false;
	}
}
