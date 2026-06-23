import { expect } from 'chai';
import { registerCollectionType, getCollectionType, getCollectionTypes, Collection, } from '../src/index.js';
import { DiaryHeaderBlockType } from '../src/collections/diary/struct.js';
import { TreeHeaderBlockType } from '../src/collections/tree/struct.js';
import { TestTransactor } from './test-transactor.js';
// Import diary and tree to trigger their side-effect registrations
import '../src/collections/diary/diary.js';
import '../src/collections/tree/struct.js';
describe('Collection Type Registry', () => {
    describe('built-in types', () => {
        it('should have Diary registered', () => {
            const descriptor = getCollectionType(DiaryHeaderBlockType);
            expect(descriptor).to.exist;
            expect(descriptor.name).to.equal('Diary');
            expect(descriptor.blockType).to.equal(DiaryHeaderBlockType);
            expect(descriptor.open).to.be.a('function');
        });
        it('should have Tree registered', () => {
            const descriptor = getCollectionType(TreeHeaderBlockType);
            expect(descriptor).to.exist;
            expect(descriptor.name).to.equal('Tree');
            expect(descriptor.blockType).to.equal(TreeHeaderBlockType);
            expect(descriptor.open).to.be.undefined;
        });
        it('should list all registered types', () => {
            const types = getCollectionTypes();
            expect(types.size).to.be.at.least(2);
            expect(types.has(DiaryHeaderBlockType)).to.be.true;
            expect(types.has(TreeHeaderBlockType)).to.be.true;
        });
    });
    describe('registry operations', () => {
        it('should throw on duplicate registration', () => {
            expect(() => registerCollectionType({
                blockType: DiaryHeaderBlockType,
                name: 'DuplicateDiary',
            })).to.throw(/already registered/);
        });
        it('should return undefined for unknown block type', () => {
            expect(getCollectionType('UNKNOWN')).to.be.undefined;
        });
    });
    describe('ICollection interface', () => {
        let transactor;
        beforeEach(() => {
            transactor = new TestTransactor();
        });
        it('should satisfy ICollection through Collection', async () => {
            const init = {
                modules: { "append": async () => { } },
                createHeaderBlock: (id, store) => ({
                    header: store.createBlockHeader('TST', id)
                })
            };
            const collection = await Collection.createOrOpen(transactor, 'iface-test', init);
            expect(collection.id).to.equal('iface-test');
            await collection.act({ type: 'append', data: 'hello' });
            await collection.updateAndSync();
            const actions = [];
            for await (const a of collection.selectLog()) {
                actions.push(a);
            }
            expect(actions).to.have.lengthOf(1);
            expect(actions[0].data).to.equal('hello');
        });
    });
    describe('registry open factory', () => {
        let transactor;
        beforeEach(() => {
            transactor = new TestTransactor();
        });
        it('should open a Diary collection via registry factory', async () => {
            const descriptor = getCollectionType(DiaryHeaderBlockType);
            expect(descriptor.open).to.be.a('function');
            const collection = await descriptor.open(transactor, 'registry-diary');
            await collection.act({ type: 'append', data: { message: 'from registry' } });
            await collection.updateAndSync();
            const actions = [];
            for await (const a of collection.selectLog()) {
                actions.push(a);
            }
            expect(actions).to.have.lengthOf(1);
            expect(actions[0].data).to.deep.equal({ message: 'from registry' });
        });
        it('should return undefined open for Tree (requires parameters)', () => {
            const descriptor = getCollectionType(TreeHeaderBlockType);
            expect(descriptor.open).to.be.undefined;
        });
    });
    describe('custom collection type', () => {
        const CounterBlockType = 'CNT';
        let transactor;
        let registered = false;
        function createCounter(transactor, id) {
            const init = {
                modules: {
                    "adjust": async () => {
                        // Counter stores state purely in the log
                    }
                },
                createHeaderBlock: (hid, store) => ({
                    header: store.createBlockHeader(CounterBlockType, hid)
                })
            };
            return Collection.createOrOpen(transactor, id, init);
        }
        before(() => {
            if (!registered) {
                registerCollectionType({
                    blockType: CounterBlockType,
                    name: 'Counter',
                    open: (t, id) => createCounter(t, id),
                });
                registered = true;
            }
        });
        beforeEach(() => {
            transactor = new TestTransactor();
        });
        it('should register and look up custom type', () => {
            const descriptor = getCollectionType(CounterBlockType);
            expect(descriptor).to.exist;
            expect(descriptor.name).to.equal('Counter');
        });
        it('should create, act, sync, and iterate a custom collection', async () => {
            const counter = await createCounter(transactor, 'my-counter');
            await counter.act({ type: 'adjust', data: 5 });
            await counter.act({ type: 'adjust', data: -2 });
            await counter.updateAndSync();
            const actions = [];
            for await (const a of counter.selectLog()) {
                actions.push(a);
            }
            expect(actions).to.have.lengthOf(2);
            expect(actions[0].data).to.equal(5);
            expect(actions[1].data).to.equal(-2);
            // Compute sum from log
            const total = actions.reduce((sum, a) => sum + a.data, 0);
            expect(total).to.equal(3);
        });
        it('should open custom collection via registry factory', async () => {
            const descriptor = getCollectionType(CounterBlockType);
            const counter = await descriptor.open(transactor, 'registry-counter');
            await counter.act({ type: 'adjust', data: 10 });
            await counter.updateAndSync();
            const actions = [];
            for await (const a of counter.selectLog()) {
                actions.push(a);
            }
            expect(actions).to.have.lengthOf(1);
            expect(actions[0].data).to.equal(10);
        });
    });
});
//# sourceMappingURL=collection-type-registry.spec.js.map