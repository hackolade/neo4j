const neo4j = require('neo4j-driver').v1;

driver = neo4j.driver(`bolt://localhost:11006`, neo4j.auth.basic('',''), {
	encrypted: 'ENCRYPTION_ON',
	trust: 'TRUST_SERVER_CLIENT_CERTIFICATES',
	trustedCertificates: ['/home/eduard/Documents/certificates/serverCA.crt'],
	key: '/home/eduard/Documents/certificates/private.key',
	cert: '/home/eduard/Documents/certificates/public.crt',
	passphrase: 'asd'
});

driver.onCompleted = () => {
	resolve();
};

driver.onError = (error) => {
	driver = null;
	console.log(error);
};