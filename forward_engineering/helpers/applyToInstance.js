const applyToInstanceHelper = require('./applyToInstanceHelper');

function applyToInstance(connectionInfo, logger, callback, app) {
	const sshService = app.require('@hackolade/ssh-service');

	applyToInstanceHelper
		.applyToInstance(connectionInfo, logger, sshService)
		.then(result => {
			callback(null, result);
		})
		.catch(error => {
			callback({ ...error, type: 'simpleError' });
		});
}

module.exports = { applyToInstance };
