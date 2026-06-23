import debug from "debug";
import { digest, sign, verify } from "@optimystic/quereus-plugin-crypto";
const log = debug("sereus:cadre:schema-verify");
class SchemaVerificationError extends Error {
  constructor(sAppId, version, reason) {
    super(`sApp schema verification failed for ${sAppId} v${version}: ${reason}`);
    this.sAppId = sAppId;
    this.version = version;
    this.name = "SchemaVerificationError";
  }
}
function schemaDigest(schema, version) {
  const payload = JSON.stringify({ schema, version });
  return digest(payload, "sha256", "utf8", "base64url");
}
function signSchema(schema, version, authorPrivateKey) {
  const d = schemaDigest(schema, version);
  return sign(d, authorPrivateKey, "ed25519", "base64url", "base64url", "base64url");
}
function verifySchema(schema, version, signature, authorPublicKey) {
  try {
    const d = schemaDigest(schema, version);
    return verify(d, signature, authorPublicKey, "ed25519", "base64url", "base64url", "base64url");
  } catch (error) {
    log("Schema verification error: %o", error);
    return false;
  }
}
function assertSchemaSignature(sAppConfig) {
  const { id, version, schema, signature } = sAppConfig;
  if (!signature) {
    log("No signature provided for %s v%s \u2014 skipping verification", id, version);
    return;
  }
  if (!id) {
    throw new SchemaVerificationError(id ?? "", version, "missing author public key");
  }
  if (!verifySchema(schema, version, signature, id)) {
    throw new SchemaVerificationError(id, version, "invalid signature");
  }
}
export {
  SchemaVerificationError,
  assertSchemaSignature,
  signSchema,
  verifySchema
};
