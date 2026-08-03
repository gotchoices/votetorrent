// Keystore preflight for the fastlane signing lanes.
//
// This deliberately does NOT use `keytool`, which is unreliable for this check:
//
//   * On a PKCS12 keystore, keytool REFUSES to honour -keypass at all. It prints
//     "Different store and key passwords not supported for PKCS12 KeyStores.
//     Ignoring user-specified -keypass value." and substitutes the store
//     password (see JDK-8008292, closed Won't Fix). So `keytool -certreq`
//     silently succeeds no matter what key password you pass — a useless check —
//     and fails with UnrecoverableKeyException on a PKCS12 that legitimately has
//     a per-key password, which the KeyStore API and apksigner both handle fine.
//
// The Android Gradle Plugin loads the store with the store password and then
// calls getEntry(alias, PasswordProtection(keyPassword)). Doing exactly that
// here means a pass in this check is a genuine prediction of a successful build.
//
// Passwords arrive via the environment, never argv, so they stay out of `ps`.
//
// Used by the fastlane signing lanes (scripts/fastlane/vt_signing.rb).
// Run with JDK 11+ single-file source launch: java scripts/VerifyKeystore.java <file> <alias>
// Emits KEY=VALUE lines on stdout; always exits 0 unless it cannot run at all.

import java.io.FileInputStream;
import java.io.InputStream;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class VerifyKeystore {
	public static void main(String[] args) {
		String file = args[0];
		String wantAlias = args[1];
		char[] storePw = chars(System.getenv("VT_STORE_PW"));
		char[] keyPw = chars(System.getenv("VT_KEY_PW"));

		String type = detectType(file);
		System.out.println("TYPE=" + type);

		KeyStore ks;
		try {
			ks = KeyStore.getInstance(type);
			try (InputStream in = new FileInputStream(file)) {
				ks.load(in, storePw);
			}
		} catch (Exception e) {
			System.out.println("STORE_OK=0");
			System.out.println("ERROR=" + oneLine(e));
			return;
		}
		System.out.println("STORE_OK=1");

		List<String> aliases = new ArrayList<>();
		try {
			Collections.list(ks.aliases()).forEach(aliases::add);
		} catch (Exception ignored) {
			// An unreadable alias list is not fatal; the getEntry below still decides.
		}
		System.out.println("ALIASES=" + String.join(",", aliases));

		if (!aliases.contains(wantAlias)) {
			System.out.println("ALIAS_OK=0");
			return;
		}
		System.out.println("ALIAS_OK=1");

		// The real test: can this key be unwrapped with the key password?
		try {
			ks.getEntry(wantAlias, new KeyStore.PasswordProtection(keyPw));
			System.out.println("KEY_OK=1");
		} catch (Exception e) {
			System.out.println("KEY_OK=0");
			System.out.println("KEY_ERROR=" + oneLine(e));
			// Distinguish "wrong password" from "this store has no per-key password",
			// which is what a keytool-made PKCS12 always looks like.
			try {
				ks.getEntry(wantAlias, new KeyStore.PasswordProtection(storePw));
				System.out.println("KEY_OPENS_WITH_STORE_PW=1");
			} catch (Exception ignored) {
				System.out.println("KEY_OPENS_WITH_STORE_PW=0");
			}
		}
	}

	// Magic bytes are the only trustworthy signal: JKS files load fine through a
	// PKCS12 KeyStore instance (keystore.type.compat), so getType() would lie.
	private static String detectType(String file) {
		try (InputStream in = new FileInputStream(file)) {
			byte[] head = new byte[4];
			if (in.read(head) != 4) {
				return "PKCS12";
			}
			int magic = ((head[0] & 0xff) << 24) | ((head[1] & 0xff) << 16)
					| ((head[2] & 0xff) << 8) | (head[3] & 0xff);
			if (magic == 0xfeedfeed) {
				return "JKS";
			}
			if (magic == 0xcececece) {
				return "JCEKS";
			}
			return "PKCS12";
		} catch (Exception e) {
			return "PKCS12";
		}
	}

	private static char[] chars(String s) {
		return s == null ? new char[0] : s.toCharArray();
	}

	private static String oneLine(Exception e) {
		String m = e.getMessage();
		String s = e.getClass().getSimpleName() + (m == null ? "" : ": " + m);
		return s.replace('\n', ' ').replace('\r', ' ');
	}
}
