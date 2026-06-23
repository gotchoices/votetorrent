import { expect } from 'chai';
import { verbose } from '../src/logger.js';
describe('Transaction Metrics (db-p2p)', () => {
    describe('verbose flag', () => {
        it('should export a verbose flag as a boolean', () => {
            expect(verbose).to.be.a('boolean');
        });
        it('should be false when OPTIMYSTIC_VERBOSE is not set', () => {
            expect(verbose).to.equal(false);
        });
    });
});
//# sourceMappingURL=transaction-metrics.spec.js.map