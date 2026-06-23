/** True if the given object has no keys.  This should not be used for classes or objects with proto fields. */
export function isRecordEmpty(record) {
    for (const _key in record)
        return false;
    return true;
}
//# sourceMappingURL=is-record-empty.js.map