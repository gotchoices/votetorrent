import { UserKeyType } from '@votetorrent/vote-core';

export const getKeyTypeDisplayName = (keyType?: UserKeyType): string => {
	if (keyType === UserKeyType.mobile) {
		return 'mobile';
	} else if (keyType === UserKeyType.yubico) {
		return 'Yubico';
	}
	return keyType || 'Unknown';
};

export const formatDate = (dateValue: number | undefined | null): string => {
	if (dateValue === undefined || dateValue === null) {
		return 'N/A';
	}
	const date = new Date(dateValue);
	return date.toISOString().split('T')[0];
};
