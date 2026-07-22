/**
 * Registration form helpers — date-input masking + field validation for the Register flow.
 *
 * The Voting app deliberately ships NO date-picker package: the registration DOB is the only date
 * input in the whole app, so a masked `MM/DD/YYYY` text field (easier, format-guided entry)
 * replaces a native picker (user direction, post-QA). All logic here is dependency-free.
 */

/** Mask raw keystrokes into `MM/DD/YYYY` as the user types. Digits-only, capped at 8, slashes
 *  auto-inserted. Backspacing works because the mask is re-derived from the remaining digits. */
export function maskDateInput(input: string): string {
	const d = input.replace(/\D/g, '').slice(0, 8);
	if (d.length <= 2) return d;
	if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
	return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(v: string): boolean {
	return EMAIL_RE.test(v.trim());
}

/** Lenient mock rule: at least 10 digits after stripping formatting. */
export function isValidPhone(v: string): boolean {
	return v.replace(/\D/g, '').length >= 10;
}

/** MM/DD/YYYY with sane month/day/year ranges (mock — not a full calendar check). */
export function isValidDob(v: string): boolean {
	const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
	if (!m) return false;
	const mm = Number(m[1]);
	const dd = Number(m[2]);
	const yyyy = Number(m[3]);
	if (mm < 1 || mm > 12) return false;
	if (dd < 1 || dd > 31) return false;
	// Upper bound uses a fixed sane ceiling (no Date.now() — keeps this pure/testable).
	if (yyyy < 1900 || yyyy > 2100) return false;
	return true;
}

/** A field's failure reason — maps 1:1 to an i18n key `form.errors.<reason>`. */
export type FieldError = 'required' | 'email' | 'phone' | 'dob' | 'party';

export interface RegistrationDraftLike {
	firstName: string;
	lastName: string;
	dob: string;
	email: string;
	phone: string;
	addressLine1: string;
	addressLine2: string;
	addressLine3: string;
	party: string;
}

export type PersonalField = 'firstName' | 'lastName' | 'dob' | 'email' | 'phone';
export type AddressPartyField = 'addressLine1' | 'party';

/** Step 1 (personal): all 5 fields required; email/phone/dob additionally format-checked. */
export function validatePersonal(
	d: RegistrationDraftLike,
): Partial<Record<PersonalField, FieldError>> {
	const e: Partial<Record<PersonalField, FieldError>> = {};
	if (!d.firstName.trim()) e.firstName = 'required';
	if (!d.lastName.trim()) e.lastName = 'required';
	if (!d.dob.trim()) e.dob = 'required';
	else if (!isValidDob(d.dob)) e.dob = 'dob';
	if (!d.email.trim()) e.email = 'required';
	else if (!isValidEmail(d.email)) e.email = 'email';
	if (!d.phone.trim()) e.phone = 'required';
	else if (!isValidPhone(d.phone)) e.phone = 'phone';
	return e;
}

/** Step 2 (address + party): address line 1 required (2/3 optional per their labels); party required. */
export function validateAddressParty(
	d: RegistrationDraftLike,
): Partial<Record<AddressPartyField, FieldError>> {
	const e: Partial<Record<AddressPartyField, FieldError>> = {};
	if (!d.addressLine1.trim()) e.addressLine1 = 'required';
	if (!d.party) e.party = 'party';
	return e;
}

export function hasErrors(e: Record<string, unknown>): boolean {
	return Object.keys(e).length > 0;
}
