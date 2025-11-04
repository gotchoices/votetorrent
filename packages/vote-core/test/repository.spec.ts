import { expect } from 'aegir/chai';
import {
	InMemoryRepository,
	Specification,
	type QueryOptions,
	type PagedResult,
	type IRepository,
} from '../src/common/repository.js';
import type { Result, AsyncResult, AppError } from '../src/common/result.js';

// Test entity
interface TestUser {
	id: string;
	name: string;
	email: string;
	age: number;
	active: boolean;
	createdAt: number;
	updatedAt: number;
}

// Test repository implementation
class TestUserRepository extends InMemoryRepository<TestUser, string> {
	generateId(): string {
		return `user-${this.nextId++}`;
	}

	extractId(entity: TestUser): string {
		return entity.id;
	}
}

// Test specification
class ActiveUserSpec extends Specification<TestUser> {
	isSatisfiedBy(entity: TestUser): boolean {
		return entity.active;
	}

	toQuery(): QueryOptions {
		return {
			where: { active: true },
		};
	}
}

class AgeRangeSpec extends Specification<TestUser> {
	constructor(
		private minAge: number,
		private maxAge: number
	) {
		super();
	}

	isSatisfiedBy(entity: TestUser): boolean {
		return entity.age >= this.minAge && entity.age <= this.maxAge;
	}

	toQuery(): QueryOptions {
		return {
			where: {
				age: { $gte: this.minAge, $lte: this.maxAge },
			},
		};
	}
}

describe('Repository Pattern', () => {
	let repository: TestUserRepository;

	beforeEach(() => {
		repository = new TestUserRepository();
	});

	afterEach(() => {
		repository.clear();
	});

	describe('CRUD Operations', () => {
		describe('create', () => {
			it('should create new entity', async () => {
				const result = await repository.create({
					name: 'John Doe',
					email: 'john@example.com',
					age: 30,
					active: true,
				});

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value.id).to.match(/^user-\d+$/);
					expect(result.value.name).to.equal('John Doe');
					expect(result.value.email).to.equal('john@example.com');
					expect(result.value.age).to.equal(30);
					expect(result.value.active).to.be.true;
					expect(result.value.createdAt).to.be.a('number');
					expect(result.value.updatedAt).to.be.a('number');
				}
			});

			it('should generate unique IDs', async () => {
				const user1 = await repository.create({
					name: 'User 1',
					email: 'user1@example.com',
					age: 25,
					active: true,
				});

				const user2 = await repository.create({
					name: 'User 2',
					email: 'user2@example.com',
					age: 30,
					active: true,
				});

				expect(user1.success && user2.success).to.be.true;
				if (user1.success && user2.success) {
					expect(user1.value.id).to.not.equal(user2.value.id);
				}
			});
		});

		describe('findById', () => {
			it('should find entity by ID', async () => {
				const created = await repository.create({
					name: 'John Doe',
					email: 'john@example.com',
					age: 30,
					active: true,
				});

				expect(created.success).to.be.true;
				if (created.success) {
					const found = await repository.findById(created.value.id);

					expect(found.success).to.be.true;
					if (found.success) {
						expect(found.value).to.not.be.null;
						expect(found.value!.id).to.equal(created.value.id);
						expect(found.value!.name).to.equal('John Doe');
					}
				}
			});

			it('should return null for non-existent ID', async () => {
				const result = await repository.findById('non-existent');

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value).to.be.null;
				}
			});
		});

		describe('update', () => {
			it('should update existing entity', async () => {
				const created = await repository.create({
					name: 'John Doe',
					email: 'john@example.com',
					age: 30,
					active: true,
				});

				expect(created.success).to.be.true;
				if (created.success) {
					const originalUpdatedAt = created.value.updatedAt;

					// Small delay to ensure updatedAt changes
					await new Promise((resolve) => setTimeout(resolve, 10));

					const updated = await repository.update(created.value.id, {
						name: 'Jane Doe',
						age: 31,
					});

					expect(updated.success).to.be.true;
					if (updated.success && updated.value) {
						expect(updated.value.name).to.equal('Jane Doe');
						expect(updated.value.age).to.equal(31);
						expect(updated.value.email).to.equal('john@example.com'); // Unchanged
						expect(updated.value.active).to.be.true; // Unchanged
						expect(updated.value.updatedAt).to.be.greaterThan(originalUpdatedAt);
					}
				}
			});

			it('should return null for non-existent ID', async () => {
				const result = await repository.update('non-existent', { name: 'Test' });

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value).to.be.null;
				}
			});

			it('should not allow ID modification', async () => {
				const created = await repository.create({
					name: 'John Doe',
					email: 'john@example.com',
					age: 30,
					active: true,
				});

				expect(created.success).to.be.true;
				if (created.success) {
					const originalId = created.value.id;

					const updated = await repository.update(created.value.id, {
						id: 'different-id',
					} as any);

					expect(updated.success).to.be.true;
					if (updated.success && updated.value) {
						expect(updated.value.id).to.equal(originalId);
					}
				}
			});
		});

		describe('delete', () => {
			it('should delete existing entity', async () => {
				const created = await repository.create({
					name: 'John Doe',
					email: 'john@example.com',
					age: 30,
					active: true,
				});

				expect(created.success).to.be.true;
				if (created.success) {
					const deleted = await repository.delete(created.value.id);

					expect(deleted.success).to.be.true;
					if (deleted.success) {
						expect(deleted.value).to.be.true;
					}

					const found = await repository.findById(created.value.id);
					expect(found.success).to.be.true;
					if (found.success) {
						expect(found.value).to.be.null;
					}
				}
			});

			it('should return false for non-existent ID', async () => {
				const result = await repository.delete('non-existent');

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value).to.be.false;
				}
			});
		});

		describe('exists', () => {
			it('should return true for existing entity', async () => {
				const created = await repository.create({
					name: 'John Doe',
					email: 'john@example.com',
					age: 30,
					active: true,
				});

				expect(created.success).to.be.true;
				if (created.success) {
					const exists = await repository.exists(created.value.id);

					expect(exists.success).to.be.true;
					if (exists.success) {
						expect(exists.value).to.be.true;
					}
				}
			});

			it('should return false for non-existent entity', async () => {
				const result = await repository.exists('non-existent');

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value).to.be.false;
				}
			});
		});
	});

	describe('Batch Operations', () => {
		describe('createMany', () => {
			it('should create multiple entities', async () => {
				const result = await repository.createMany([
					{ name: 'User 1', email: 'user1@example.com', age: 25, active: true },
					{ name: 'User 2', email: 'user2@example.com', age: 30, active: true },
					{ name: 'User 3', email: 'user3@example.com', age: 35, active: false },
				]);

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value).to.have.length(3);
					expect(result.value[0]!.name).to.equal('User 1');
					expect(result.value[1]!.name).to.equal('User 2');
					expect(result.value[2]!.name).to.equal('User 3');
				}
			});
		});

		describe('deleteMany', () => {
			it('should delete multiple entities', async () => {
				const users = await repository.createMany([
					{ name: 'User 1', email: 'user1@example.com', age: 25, active: true },
					{ name: 'User 2', email: 'user2@example.com', age: 30, active: true },
					{ name: 'User 3', email: 'user3@example.com', age: 35, active: false },
				]);

				expect(users.success).to.be.true;
				if (users.success) {
					const ids = users.value.map((u) => u.id);
					const result = await repository.deleteMany(ids);

					expect(result.success).to.be.true;
					if (result.success) {
						expect(result.value).to.equal(3);
					}

					const count = await repository.count();
					expect(count.success).to.be.true;
					if (count.success) {
						expect(count.value).to.equal(0);
					}
				}
			});

			it('should only count successfully deleted entities', async () => {
				const user = await repository.create({
					name: 'User 1',
					email: 'user1@example.com',
					age: 25,
					active: true,
				});

				expect(user.success).to.be.true;
				if (user.success) {
					const result = await repository.deleteMany([
						user.value.id,
						'non-existent-1',
						'non-existent-2',
					]);

					expect(result.success).to.be.true;
					if (result.success) {
						expect(result.value).to.equal(1);
					}
				}
			});
		});
	});

	describe('Query Operations', () => {
		beforeEach(async () => {
			await repository.createMany([
				{ name: 'Alice', email: 'alice@example.com', age: 25, active: true },
				{ name: 'Bob', email: 'bob@example.com', age: 30, active: true },
				{ name: 'Charlie', email: 'charlie@example.com', age: 35, active: false },
				{ name: 'David', email: 'david@example.com', age: 40, active: true },
				{ name: 'Eve', email: 'eve@example.com', age: 45, active: false },
			]);
		});

		describe('findAll', () => {
			it('should find all entities', async () => {
				const result = await repository.findAll();

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value).to.have.length(5);
				}
			});

			it('should filter by criteria', async () => {
				const result = await repository.findAll({
					where: { active: true },
				});

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value).to.have.length(3);
					expect(result.value.every((u) => u.active)).to.be.true;
				}
			});

			it('should sort results', async () => {
				const result = await repository.findAll({
					orderBy: [{ field: 'age', direction: 'desc' }],
				});

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value[0]!.name).to.equal('Eve');
					expect(result.value[4]!.name).to.equal('Alice');
				}
			});

			it('should paginate results', async () => {
				const result = await repository.findAll({
					skip: 1,
					take: 2,
				});

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value).to.have.length(2);
				}
			});

			it('should combine filtering and sorting', async () => {
				const result = await repository.findAll({
					where: { active: true },
					orderBy: [{ field: 'age', direction: 'desc' }],
				});

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value).to.have.length(3);
					expect(result.value[0]!.name).to.equal('David');
					expect(result.value[2]!.name).to.equal('Alice');
				}
			});
		});

		describe('findPaged', () => {
			it('should return paginated results', async () => {
				const result = await repository.findPaged(1, 2);

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value.items).to.have.length(2);
					expect(result.value.pageInfo.page).to.equal(1);
					expect(result.value.pageInfo.pageSize).to.equal(2);
					expect(result.value.pageInfo.totalCount).to.equal(5);
					expect(result.value.pageInfo.totalPages).to.equal(3);
					expect(result.value.pageInfo.hasNext).to.be.true;
					expect(result.value.pageInfo.hasPrevious).to.be.false;
				}
			});

			it('should handle last page correctly', async () => {
				const result = await repository.findPaged(3, 2);

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value.items).to.have.length(1);
					expect(result.value.pageInfo.hasNext).to.be.false;
					expect(result.value.pageInfo.hasPrevious).to.be.true;
				}
			});

			it('should combine pagination with filtering', async () => {
				const result = await repository.findPaged(1, 2, {
					where: { active: true },
				});

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value.items).to.have.length(2);
					expect(result.value.pageInfo.totalCount).to.equal(3);
					expect(result.value.pageInfo.totalPages).to.equal(2);
				}
			});
		});

		describe('count', () => {
			it('should count all entities', async () => {
				const result = await repository.count();

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value).to.equal(5);
				}
			});

			it('should count filtered entities', async () => {
				const result = await repository.count({
					where: { active: true },
				});

				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.value).to.equal(3);
				}
			});
		});
	});

	describe('Specification Pattern', () => {
		beforeEach(async () => {
			await repository.createMany([
				{ name: 'Alice', email: 'alice@example.com', age: 25, active: true },
				{ name: 'Bob', email: 'bob@example.com', age: 30, active: true },
				{ name: 'Charlie', email: 'charlie@example.com', age: 35, active: false },
				{ name: 'David', email: 'david@example.com', age: 40, active: true },
			]);
		});

		it('should filter by simple specification', () => {
			const activeSpec = new ActiveUserSpec();
			const users = [
				{ id: '1', name: 'Alice', email: 'alice@example.com', age: 25, active: true, createdAt: 0, updatedAt: 0 },
				{ id: '2', name: 'Bob', email: 'bob@example.com', age: 30, active: false, createdAt: 0, updatedAt: 0 },
			];

			expect(activeSpec.isSatisfiedBy(users[0]!)).to.be.true;
			expect(activeSpec.isSatisfiedBy(users[1]!)).to.be.false;
		});

		it('should combine specifications with AND', () => {
			const activeSpec = new ActiveUserSpec();
			const ageSpec = new AgeRangeSpec(25, 35);
			const combined = activeSpec.and(ageSpec);

			const user1 = { id: '1', name: 'Alice', email: 'alice@example.com', age: 25, active: true, createdAt: 0, updatedAt: 0 };
			const user2 = { id: '2', name: 'Bob', email: 'bob@example.com', age: 40, active: true, createdAt: 0, updatedAt: 0 };
			const user3 = { id: '3', name: 'Charlie', email: 'charlie@example.com', age: 30, active: false, createdAt: 0, updatedAt: 0 };

			expect(combined.isSatisfiedBy(user1)).to.be.true; // Active AND age in range
			expect(combined.isSatisfiedBy(user2)).to.be.false; // Active but age out of range
			expect(combined.isSatisfiedBy(user3)).to.be.false; // Age in range but not active
		});

		it('should combine specifications with OR', () => {
			const activeSpec = new ActiveUserSpec();
			const ageSpec = new AgeRangeSpec(40, 50);
			const combined = activeSpec.or(ageSpec);

			const user1 = { id: '1', name: 'Alice', email: 'alice@example.com', age: 25, active: true, createdAt: 0, updatedAt: 0 };
			const user2 = { id: '2', name: 'Bob', email: 'bob@example.com', age: 45, active: false, createdAt: 0, updatedAt: 0 };
			const user3 = { id: '3', name: 'Charlie', email: 'charlie@example.com', age: 20, active: false, createdAt: 0, updatedAt: 0 };

			expect(combined.isSatisfiedBy(user1)).to.be.true; // Active
			expect(combined.isSatisfiedBy(user2)).to.be.true; // Age in range
			expect(combined.isSatisfiedBy(user3)).to.be.false; // Neither
		});

		it('should negate specification with NOT', () => {
			const activeSpec = new ActiveUserSpec();
			const notActive = activeSpec.not();

			const user1 = { id: '1', name: 'Alice', email: 'alice@example.com', age: 25, active: true, createdAt: 0, updatedAt: 0 };
			const user2 = { id: '2', name: 'Bob', email: 'bob@example.com', age: 30, active: false, createdAt: 0, updatedAt: 0 };

			expect(notActive.isSatisfiedBy(user1)).to.be.false;
			expect(notActive.isSatisfiedBy(user2)).to.be.true;
		});

		it('should convert specification to query', () => {
			const activeSpec = new ActiveUserSpec();
			const query = activeSpec.toQuery();

			expect(query.where).to.deep.equal({ active: true });
		});
	});
});
