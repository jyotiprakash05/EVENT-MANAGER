const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('AWS Configuration - aws-config.js exists and is valid', () => {
    const configPath = path.join(__dirname, '..', 'aws-config.js');
    assert.ok(fs.existsSync(configPath), 'aws-config.js must exist');

    const content = fs.readFileSync(configPath, 'utf8');
    
    // Simulate window object in sandboxed scope
    const sandboxWindow = {};
    const evalFunction = new Function('window', content);
    evalFunction(sandboxWindow);

    const config = sandboxWindow.EVENTPRO_AWS_CONFIG;
    assert.ok(config, 'EVENTPRO_AWS_CONFIG should be defined on window');
    assert.strictEqual(typeof config.region, 'string', 'region must be a string');
    assert.match(config.region, /^[a-z]{2}-[a-z]+-\d+$/, 'region must match AWS region format (e.g., ap-south-1)');
    
    assert.ok(config.userPoolId, 'userPoolId must be set');
    assert.ok(config.clientId, 'clientId must be set');
    assert.ok(config.dynamoDBTableName, 'dynamoDBTableName must be configured');
    assert.ok(config.eventsTableName, 'eventsTableName must be configured');
    assert.ok(config.ticketsTableName, 'ticketsTableName must be configured');
    assert.ok(config.paymentsTableName, 'paymentsTableName must be configured');
    assert.ok(config.checkinsTableName, 'checkinsTableName must be configured');
    assert.ok(config.reviewsTableName, 'reviewsTableName must be configured');
    assert.ok(config.s3BucketName, 's3BucketName must be configured');
});
