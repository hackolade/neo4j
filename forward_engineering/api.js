const { applyToInstance } = require('./helpers/applyToInstance');
const { testConnection } = require('./helpers/testConnection');
const { generateContainerScript } = require('./helpers/generateContainerScript');

module.exports = {
	generateContainerScript,
	applyToInstance,
	testConnection,
};
