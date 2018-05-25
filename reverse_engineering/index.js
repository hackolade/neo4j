const neo4j = require('neo4j-driver').v1;

driver = neo4j.driver(`bolt://localhost:11006`, neo4j.auth.basic('',''), {
	encrypted: 'ENCRYPTION_ON',
	trust: 'TRUST_CUSTOM_CA_SIGNED_CERTIFICATES',
	trustedCertificates: ['/home/eduard/Documents/certificates/serverCA.crt'],
	key: 'asd',
	cert: 'aasd',
	passphrase: 'asd'
});

driver.onCompleted = () => {
	resolve();
};

driver.onError = (error) => {
	driver = null;
	console.log(error);
};