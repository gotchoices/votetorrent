import {
	maskDateInput,
	isValidEmail,
	isValidPhone,
	isValidDob,
	validatePersonal,
	validateAddressParty,
	hasErrors,
	type RegistrationDraftLike,
} from '../registrationForm';

const base: RegistrationDraftLike = {
	firstName: 'Jane',
	lastName: 'Doe',
	dob: '01/02/2003',
	email: 'jane@example.com',
	phone: '8011234567',
	addressLine1: '10 Example Rd',
	addressLine2: '',
	addressLine3: '',
	party: 'independent',
};

describe('maskDateInput', () => {
	it('inserts slashes progressively as digits are typed', () => {
		expect(maskDateInput('1')).toBe('1');
		expect(maskDateInput('12')).toBe('12');
		expect(maskDateInput('123')).toBe('12/3');
		expect(maskDateInput('1231')).toBe('12/31');
		expect(maskDateInput('12312')).toBe('12/31/2');
		expect(maskDateInput('12312000')).toBe('12/31/2000');
	});
	it('strips non-digits and caps at 8 digits', () => {
		expect(maskDateInput('ab12cd31ef2000gh99')).toBe('12/31/2000');
	});
});

describe('validators', () => {
	it('isValidEmail', () => {
		expect(isValidEmail('a@b.co')).toBe(true);
		expect(isValidEmail('nope')).toBe(false);
		expect(isValidEmail('a@b')).toBe(false);
	});
	it('isValidPhone (>=10 digits after stripping)', () => {
		expect(isValidPhone('801-123-4567')).toBe(true);
		expect(isValidPhone('12345')).toBe(false);
	});
	it('isValidDob (MM/DD/YYYY with sane ranges)', () => {
		expect(isValidDob('01/02/2003')).toBe(true);
		expect(isValidDob('13/02/2003')).toBe(false); // month
		expect(isValidDob('01/40/2003')).toBe(false); // day
		expect(isValidDob('1/2/2003')).toBe(false); // unmasked
		expect(isValidDob('01/02/1800')).toBe(false); // year floor
	});
});

describe('validatePersonal', () => {
	it('passes for a fully valid draft', () => {
		expect(hasErrors(validatePersonal(base))).toBe(false);
	});
	it('flags empties as required and bad formats specifically', () => {
		const e = validatePersonal({...base, firstName: '', email: 'x', phone: '1', dob: '99/99/9999'});
		expect(e.firstName).toBe('required');
		expect(e.email).toBe('email');
		expect(e.phone).toBe('phone');
		expect(e.dob).toBe('dob');
	});
});

describe('validateAddressParty', () => {
	it('passes when address line 1 + party are present', () => {
		expect(hasErrors(validateAddressParty(base))).toBe(false);
	});
	it('flags missing address line 1 and party', () => {
		const e = validateAddressParty({...base, addressLine1: '', party: ''});
		expect(e.addressLine1).toBe('required');
		expect(e.party).toBe('party');
	});
	it('treats address lines 2 and 3 as optional', () => {
		expect(hasErrors(validateAddressParty({...base, addressLine2: '', addressLine3: ''}))).toBe(false);
	});
});
