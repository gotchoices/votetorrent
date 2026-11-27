/**
 * The name to show for the open network: `Network.Name` of the joined (or dev-seeded) network,
 * or the `common:networkName` copy while none is open or its name has not been read yet.
 */
import {useTranslation} from 'react-i18next';
import {useVoterApp} from '../providers/VoterAppProvider';

export function useNetworkName(): string {
	const {networkName} = useVoterApp();
	const {t} = useTranslation('common');
	return networkName ?? t('networkName');
}
