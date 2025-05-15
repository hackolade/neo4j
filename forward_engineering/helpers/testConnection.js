const applyToInstanceHelper = require('./applyToInstanceHelper');

function testConnection(connectionInfo, logger, callback, app) {
	const sshService = app.require('@hackolade/ssh-service');

	applyToInstanceHelper.testConnection(connectionInfo, sshService).then(callback, err => {
		logger.log('error', err, 'Neo4j test connection error');
		callback({ ...err, type: 'simpleError' });
	});
}

module.exports = { testConnection };
