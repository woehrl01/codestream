// Errors related to the users module

'use strict';

module.exports = {
	'token': {
		code: 'USRC-1000',
		message: 'Token error',
		internal: true
	},
	'passwordMismatch': {
		code: 'USRC-1001',
		message: 'Password doesn\'t match'
	},
	'confirmCodeMismatch': {
		code: 'USRC-1002',
		message: 'Confirmation code doesn\'t match'
	},
	'confirmCodeExpired': {
		code: 'USRC-1003',
		message: 'Confirmation code is expired'
	},
	'tooManyConfirmAttempts': {
		code: 'USRC-1004',
		message: 'Confirmation code doesn\'t match; too many attempts'
	},
	'emailMismatch': {
		code: 'USRC-1005',
		message: 'Email doesn\'t match'
	},
	'alreadyRegistered': {
		code: 'USRC-1006',
		message: 'This user is already registered and confirmed'
	},
	'messagingGrant': {
		code: 'USRC-1007',
		message: 'Unable to grant user messaging permissions'
	},
	'invalidGrantChannel': {
		code: 'USRC-1008',
		message: 'Invalid grant channel'
	},
	/* deprecated
	'invalidBetaCode': {
		code: 'USRC-1009',
		message: 'Invalid beta code'
	},
	*/
	'noLoginUnregistered': {
		code: 'USRC-1010',
		message: 'User has not yet confirmed registration'
	}
};
