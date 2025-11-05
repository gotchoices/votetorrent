import { expect } from 'aegir/chai';
import {
	Ok,
	Err,
	isOk,
	isErr,
	ResultUtils,
	Errors,
	ErrorType,
	type Result,
	type AppError,
} from '../src/common/result.js';

describe('Result Type', () => {
	describe('Basic Construction', () => {
		it('should create Ok result', () => {
			const result = Ok(42);
			expect(result.success).to.be.true;
			expect(result.value).to.equal(42);
		});

		it('should create Err result', () => {
			const result = Err('error message');
			expect(result.success).to.be.false;
			expect(result.error).to.equal('error message');
		});

		it('should work with different types', () => {
			const stringResult = Ok('hello');
			const numberResult = Ok(123);
			const objectResult = Ok({ name: 'test' });

			expect(stringResult.value).to.equal('hello');
			expect(numberResult.value).to.equal(123);
			expect(objectResult.value).to.deep.equal({ name: 'test' });
		});
	});

	describe('Type Guards', () => {
		it('should identify Ok result', () => {
			const result = Ok(42);
			expect(isOk(result)).to.be.true;
			expect(isErr(result)).to.be.false;
		});

		it('should identify Err result', () => {
			const result = Err('error');
			expect(isOk(result)).to.be.false;
			expect(isErr(result)).to.be.true;
		});

		it('should provide type narrowing', () => {
			const result: Result<number, string> = Ok(42);

			if (isOk(result)) {
				// TypeScript should know result.value is number
				const num: number = result.value;
				expect(num).to.equal(42);
			} else {
				expect.fail('Should not reach here');
			}
		});
	});

	describe('ResultUtils.map', () => {
		it('should map Ok value', () => {
			const result = Ok(5);
			const mapped = ResultUtils.map(result, (x) => x * 2);

			expect(isOk(mapped)).to.be.true;
			if (isOk(mapped)) {
				expect(mapped.value).to.equal(10);
			}
		});

		it('should not map Err', () => {
			const result: Result<number, string> = Err('error');
			const mapped = ResultUtils.map(result, (x: number) => x * 2);

			expect(isErr(mapped)).to.be.true;
			if (isErr(mapped)) {
				expect(mapped.error).to.equal('error');
			}
		});

		it('should change value type', () => {
			const result = Ok(42);
			const mapped = ResultUtils.map(result, (x) => x.toString());

			expect(isOk(mapped)).to.be.true;
			if (isOk(mapped)) {
				expect(mapped.value).to.equal('42');
			}
		});
	});

	describe('ResultUtils.mapErr', () => {
		it('should map Err value', () => {
			const result: Result<number, string> = Err('error');
			const mapped = ResultUtils.mapErr(result, (e) => e.toUpperCase());

			expect(isErr(mapped)).to.be.true;
			if (isErr(mapped)) {
				expect(mapped.error).to.equal('ERROR');
			}
		});

		it('should not map Ok', () => {
			const result: Result<number, string> = Ok(42);
			const mapped = ResultUtils.mapErr(result, (e: string) => e.toUpperCase());

			expect(isOk(mapped)).to.be.true;
			if (isOk(mapped)) {
				expect(mapped.value).to.equal(42);
			}
		});
	});

	describe('ResultUtils.andThen', () => {
		it('should chain Ok results', () => {
			const result = Ok(5);
			const chained = ResultUtils.andThen(result, (x) => Ok(x * 2));

			expect(isOk(chained)).to.be.true;
			if (isOk(chained)) {
				expect(chained.value).to.equal(10);
			}
		});

		it('should stop chain on first Err', () => {
			const result: Result<number, string> = Ok(5);
			const chained = ResultUtils.andThen(result, (x) => Err('failed'));

			expect(isErr(chained)).to.be.true;
			if (isErr(chained)) {
				expect(chained.error).to.equal('failed');
			}
		});

		it('should not execute if already Err', () => {
			const result: Result<number, string> = Err('initial error');
			let executed = false;
			const chained = ResultUtils.andThen(result, (x: number) => {
				executed = true;
				return Ok(x * 2);
			});

			expect(executed).to.be.false;
			expect(isErr(chained)).to.be.true;
		});
	});

	describe('ResultUtils.unwrapOr', () => {
		it('should unwrap Ok value', () => {
			const result = Ok(42);
			const value = ResultUtils.unwrapOr(result, 0);
			expect(value).to.equal(42);
		});

		it('should return default for Err', () => {
			const result: Result<number, string> = Err('error');
			const value = ResultUtils.unwrapOr(result, 0);
			expect(value).to.equal(0);
		});
	});

	describe('ResultUtils.unwrap', () => {
		it('should unwrap Ok value', () => {
			const result = Ok(42);
			const value = ResultUtils.unwrap(result);
			expect(value).to.equal(42);
		});

		it('should throw on Err', () => {
			const result: Result<number, string> = Err('error');
			expect(() => ResultUtils.unwrap(result)).to.throw('error');
		});
	});

	describe('ResultUtils.all', () => {
		it('should combine all Ok results', () => {
			const results = [Ok(1), Ok(2), Ok(3)];
			const combined = ResultUtils.all(results);

			expect(isOk(combined)).to.be.true;
			if (isOk(combined)) {
				expect(combined.value).to.deep.equal([1, 2, 3]);
			}
		});

		it('should return first Err', () => {
			const results: Array<Result<number, string>> = [
				Ok(1),
				Err('error1'),
				Err('error2'),
			];
			const combined = ResultUtils.all(results);

			expect(isErr(combined)).to.be.true;
			if (isErr(combined)) {
				expect(combined.error).to.equal('error1');
			}
		});

		it('should handle empty array', () => {
			const results: Array<Result<number, string>> = [];
			const combined = ResultUtils.all(results);

			expect(isOk(combined)).to.be.true;
			if (isOk(combined)) {
				expect(combined.value).to.deep.equal([]);
			}
		});
	});

	describe('ResultUtils.firstOk', () => {
		it('should return first Ok result', () => {
			const results: Array<Result<number, string>> = [
				Err('error1'),
				Ok(42),
				Ok(100),
			];
			const first = ResultUtils.firstOk(results);

			expect(isOk(first)).to.be.true;
			if (isOk(first)) {
				expect(first.value).to.equal(42);
			}
		});

		it('should return last Err if all fail', () => {
			const results: Array<Result<number, string>> = [
				Err('error1'),
				Err('error2'),
				Err('error3'),
			];
			const first = ResultUtils.firstOk(results);

			expect(isErr(first)).to.be.true;
			if (isErr(first)) {
				expect(first.error).to.equal('error3');
			}
		});

		it('should throw on empty array', () => {
			const results: Array<Result<number, string>> = [];
			expect(() => ResultUtils.firstOk(results)).to.throw();
		});
	});

	describe('ResultUtils.tryCatch', () => {
		it('should catch and convert to Ok', () => {
			const result = ResultUtils.tryCatch(() => 42);

			expect(isOk(result)).to.be.true;
			if (isOk(result)) {
				expect(result.value).to.equal(42);
			}
		});

		it('should catch exception and convert to Err', () => {
			const result = ResultUtils.tryCatch(() => {
				throw new Error('failed');
			});

			expect(isErr(result)).to.be.true;
			if (isErr(result)) {
				expect(result.error).to.be.instanceOf(Error);
				expect(result.error.message).to.equal('failed');
			}
		});

		it('should support custom error mapping', () => {
			const result = ResultUtils.tryCatch(
				() => {
					throw new Error('failed');
				},
				(error) => 'custom error'
			);

			expect(isErr(result)).to.be.true;
			if (isErr(result)) {
				expect(result.error).to.equal('custom error');
			}
		});
	});

	describe('ResultUtils.tryCatchAsync', () => {
		it('should catch and convert async Ok', async () => {
			const result = await ResultUtils.tryCatchAsync(async () => 42);

			expect(isOk(result)).to.be.true;
			if (isOk(result)) {
				expect(result.value).to.equal(42);
			}
		});

		it('should catch async exception and convert to Err', async () => {
			const result = await ResultUtils.tryCatchAsync(async () => {
				throw new Error('async failed');
			});

			expect(isErr(result)).to.be.true;
			if (isErr(result)) {
				expect(result.error).to.be.instanceOf(Error);
				expect(result.error.message).to.equal('async failed');
			}
		});

		it('should support custom error mapping for async', async () => {
			const result = await ResultUtils.tryCatchAsync(
				async () => {
					throw new Error('failed');
				},
				(error) => 'custom async error'
			);

			expect(isErr(result)).to.be.true;
			if (isErr(result)) {
				expect(result.error).to.equal('custom async error');
			}
		});
	});

	describe('ResultUtils.match', () => {
		it('should execute ok handler for Ok', () => {
			const result = Ok(42);
			const output = ResultUtils.match(result, {
				ok: (value) => `Success: ${value}`,
				err: (error) => `Error: ${error}`,
			});

			expect(output).to.equal('Success: 42');
		});

		it('should execute err handler for Err', () => {
			const result: Result<number, string> = Err('failed');
			const output = ResultUtils.match(result, {
				ok: (value) => `Success: ${value}`,
				err: (error) => `Error: ${error}`,
			});

			expect(output).to.equal('Error: failed');
		});
	});

	describe('ResultUtils.tap', () => {
		it('should execute function for Ok', () => {
			let sideEffect = 0;
			const result = Ok(42);
			const tapped = ResultUtils.tap(result, (value) => {
				sideEffect = value;
			});

			expect(sideEffect).to.equal(42);
			expect(tapped).to.equal(result);
		});

		it('should not execute function for Err', () => {
			let executed = false;
			const result: Result<number, string> = Err('error');
			const tapped = ResultUtils.tap(result, () => {
				executed = true;
			});

			expect(executed).to.be.false;
			expect(tapped).to.equal(result);
		});
	});

	describe('ResultUtils.tapErr', () => {
		it('should execute function for Err', () => {
			let sideEffect = '';
			const result: Result<number, string> = Err('error');
			const tapped = ResultUtils.tapErr(result, (error) => {
				sideEffect = error;
			});

			expect(sideEffect).to.equal('error');
			expect(tapped).to.equal(result);
		});

		it('should not execute function for Ok', () => {
			let executed = false;
			const result = Ok(42);
			const tapped = ResultUtils.tapErr(result, () => {
				executed = true;
			});

			expect(executed).to.be.false;
			expect(tapped).to.equal(result);
		});
	});

	describe('AppError and Errors', () => {
		it('should create validation error', () => {
			const error = Errors.validation('Invalid input', { field: 'email' });

			expect(error.type).to.equal(ErrorType.VALIDATION);
			expect(error.message).to.equal('Invalid input');
			expect(error.details).to.deep.equal({ field: 'email' });
		});

		it('should create not found error', () => {
			const error = Errors.notFound('User', '123');

			expect(error.type).to.equal(ErrorType.NOT_FOUND);
			expect(error.message).to.equal('User not found');
			expect(error.details).to.deep.equal({ id: '123' });
		});

		it('should create unauthorized error', () => {
			const error = Errors.unauthorized();

			expect(error.type).to.equal(ErrorType.UNAUTHORIZED);
			expect(error.message).to.equal('Unauthorized');
		});

		it('should create internal error with cause', () => {
			const cause = new Error('Database connection failed');
			const error = Errors.internal('Failed to fetch user', cause);

			expect(error.type).to.equal(ErrorType.INTERNAL);
			expect(error.message).to.equal('Failed to fetch user');
			expect(error.cause).to.equal(cause);
		});
	});

	describe('Real-world Patterns', () => {
		it('should chain multiple operations', () => {
			const divide = (a: number, b: number): Result<number, string> =>
				b === 0 ? Err('Division by zero') : Ok(a / b);

			const result = ResultUtils.andThen(divide(10, 2), (x) =>
				ResultUtils.andThen(divide(x, 5), (y) => Ok(y + 1))
			);

			expect(isOk(result)).to.be.true;
			if (isOk(result)) {
				expect(result.value).to.equal(2); // (10/2)/5 + 1 = 2
			}
		});

		it('should handle validation pipeline', () => {
			interface User {
				email: string;
				age: number;
			}

			const validateEmail = (user: User): Result<User, AppError> =>
				user.email.includes('@')
					? Ok(user)
					: Err(Errors.validation('Invalid email'));

			const validateAge = (user: User): Result<User, AppError> =>
				user.age >= 18 ? Ok(user) : Err(Errors.validation('Must be 18+'));

			const user = { email: 'test@example.com', age: 25 };
			const result = ResultUtils.andThen(validateEmail(user), validateAge);

			expect(isOk(result)).to.be.true;
		});
	});
});
