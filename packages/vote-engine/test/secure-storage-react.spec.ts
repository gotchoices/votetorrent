import { expect } from 'aegir/chai';
import * as Keychain from 'react-native-keychain';
import { SecureStorageReact } from '../src/secure-storage-react.js';
import sinon from 'sinon';

describe('SecureStorageReact', () => {
	let secureStorage: SecureStorageReact;
	let setGenericPasswordStub: sinon.SinonStub;
	let getGenericPasswordStub: sinon.SinonStub;
	let resetGenericPasswordStub: sinon.SinonStub;
	let getSupportedBiometryTypeStub: sinon.SinonStub;

	beforeEach(() => {
		// Create fresh stubs for each test
		setGenericPasswordStub = sinon.stub();
		getGenericPasswordStub = sinon.stub();
		resetGenericPasswordStub = sinon.stub();
		getSupportedBiometryTypeStub = sinon.stub();

		// Replace Keychain methods with stubs
		(Keychain as any).setGenericPassword = setGenericPasswordStub;
		(Keychain as any).getGenericPassword = getGenericPasswordStub;
		(Keychain as any).resetGenericPassword = resetGenericPasswordStub;
		(Keychain as any).getSupportedBiometryType = getSupportedBiometryTypeStub;

		secureStorage = new SecureStorageReact('test-service');
	});

	describe('setItem', () => {
		it('should store a value securely', async () => {
			getGenericPasswordStub.resolves(false);
			setGenericPasswordStub.resolves(true);

			const testValue = { secret: 'my-private-key' };
			await secureStorage.setItem('testKey', testValue);

			expect(setGenericPasswordStub.calledOnce).to.be.true;
			const [username, password, options] = setGenericPasswordStub.firstCall.args;
			expect(username).to.equal('test-service');
			expect(JSON.parse(password)).to.deep.equal({ testKey: testValue });
			expect(options.service).to.equal('test-service');
		});

		it('should preserve existing values when adding new item', async () => {
			const existingData = { existingKey: 'existingValue' };
			getGenericPasswordStub.resolves({
				username: 'test-service',
				password: JSON.stringify(existingData),
			});
			setGenericPasswordStub.resolves(true);

			await secureStorage.setItem('newKey', 'newValue');

			const [, password] = setGenericPasswordStub.firstCall.args;
			expect(JSON.parse(password)).to.deep.equal({
				existingKey: 'existingValue',
				newKey: 'newValue',
			});
		});

		it('should support biometric protection', async () => {
			getGenericPasswordStub.resolves(false);
			setGenericPasswordStub.resolves(true);

			await secureStorage.setItem('sensitiveKey', 'sensitiveValue', {
				requireBiometric: true,
			});

			const [, , options] = setGenericPasswordStub.firstCall.args;
			expect(options.accessControl).to.equal(Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET);
			expect(options.accessible).to.equal(Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY);
		});
	});

	describe('getItem', () => {
		it('should retrieve a stored value', async () => {
			const storedData = { testKey: 'testValue', anotherKey: 'anotherValue' };
			getGenericPasswordStub.resolves({
				username: 'test-service',
				password: JSON.stringify(storedData),
			});

			const result = await secureStorage.getItem('testKey');
			expect(result).to.equal('testValue');
		});

		it('should return undefined for non-existent key', async () => {
			getGenericPasswordStub.resolves({
				username: 'test-service',
				password: JSON.stringify({ otherKey: 'otherValue' }),
			});

			const result = await secureStorage.getItem('nonExistent');
			expect(result).to.be.undefined;
		});

		it('should return undefined when storage is empty', async () => {
			getGenericPasswordStub.resolves(false);

			const result = await secureStorage.getItem('anyKey');
			expect(result).to.be.undefined;
		});

		it('should handle JSON parsing errors', async () => {
			getGenericPasswordStub.resolves({
				username: 'test-service',
				password: 'invalid json',
			});

			const result = await secureStorage.getItem('testKey');
			expect(result).to.be.undefined;
		});
	});

	describe('removeItem', () => {
		it('should remove a specific item', async () => {
			const storedData = { key1: 'value1', key2: 'value2' };
			getGenericPasswordStub.resolves({
				username: 'test-service',
				password: JSON.stringify(storedData),
			});
			setGenericPasswordStub.resolves(true);

			await secureStorage.removeItem('key1');

			expect(setGenericPasswordStub.calledOnce).to.be.true;
			const [, password] = setGenericPasswordStub.firstCall.args;
			expect(JSON.parse(password)).to.deep.equal({ key2: 'value2' });
		});

		it('should clear storage when removing last item', async () => {
			const storedData = { onlyKey: 'onlyValue' };
			getGenericPasswordStub.resolves({
				username: 'test-service',
				password: JSON.stringify(storedData),
			});
			resetGenericPasswordStub.resolves(true);

			await secureStorage.removeItem('onlyKey');

			expect(resetGenericPasswordStub.calledOnce).to.be.true;
			expect(setGenericPasswordStub.called).to.be.false;
		});
	});

	describe('clear', () => {
		it('should clear all stored values', async () => {
			resetGenericPasswordStub.resolves(true);

			await secureStorage.clear();

			expect(resetGenericPasswordStub.calledOnce).to.be.true;
			const [options] = resetGenericPasswordStub.firstCall.args;
			expect(options.service).to.equal('test-service');
		});
	});

	describe('biometric support', () => {
		it('should check if biometric is available', async () => {
			getSupportedBiometryTypeStub.resolves(Keychain.BIOMETRY_TYPE.FACE_ID);

			const result = await secureStorage.isBiometricAvailable();
			expect(result).to.be.true;
		});

		it('should return false when biometric is not available', async () => {
			getSupportedBiometryTypeStub.resolves(null);

			const result = await secureStorage.isBiometricAvailable();
			expect(result).to.be.false;
		});

		it('should get biometry type', async () => {
			getSupportedBiometryTypeStub.resolves(Keychain.BIOMETRY_TYPE.TOUCH_ID);

			const result = await secureStorage.getBiometryType();
			expect(result).to.equal(Keychain.BIOMETRY_TYPE.TOUCH_ID);
		});
	});

	describe('complex data types', () => {
		it('should handle object storage', async () => {
			getGenericPasswordStub.resolves(false);
			setGenericPasswordStub.resolves(true);

			const complexObject = {
				user: 'alice',
				keys: ['key1', 'key2'],
				metadata: { created: Date.now() },
			};

			await secureStorage.setItem('complex', complexObject);

			getGenericPasswordStub.resolves({
				username: 'test-service',
				password: JSON.stringify({ complex: complexObject }),
			});

			const result = await secureStorage.getItem('complex');
			expect(result).to.deep.equal(complexObject);
		});

		it('should handle array storage', async () => {
			getGenericPasswordStub.resolves(false);
			setGenericPasswordStub.resolves(true);

			const array = [1, 2, 3, 'four', { five: 5 }];
			await secureStorage.setItem('array', array);

			getGenericPasswordStub.resolves({
				username: 'test-service',
				password: JSON.stringify({ array }),
			});

			const result = await secureStorage.getItem('array');
			expect(result).to.deep.equal(array);
		});
	});
});
