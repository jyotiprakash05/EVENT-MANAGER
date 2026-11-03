// Automatically upgrade to HTTPS in production/mobile browsers for WebRTC camera & crypto security
(function enforceSecureContext() {
    if (typeof window !== 'undefined' && window.location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
        let secureUrl = window.location.href.replace(/^http:/, 'https:');
        if (secureUrl.includes('.s3-website.')) {
            secureUrl = secureUrl.replace('.s3-website.', '.s3.');
        }
        window.location.replace(secureUrl);
    }
})();

window.EVENTPRO_AWS_CONFIG = {
    region: "ap-south-1",
    userPoolId: "ap-south-1_jpmIIWg5V",
    clientId: "2srk9os95n7qs30v679ao96phn",
    identityPoolId: "ap-south-1:6c21b1cb-b9f5-4979-bcca-cc8c91771719", // Add your Cognito Identity Pool ID here
    dynamoDBTableName: "EventProUsers", // Your DynamoDB table name
    eventsTableName: "EventProEvents",
    ticketsTableName: "EventProTickets",
    paymentsTableName: "EventProPayments",
    checkinsTableName: "EventProCheckins",
    reviewsTableName: "EventProReviews",
    alertsTableName: "EventProAlerts",
    s3BucketName: "eventpro-images", // Replace with your actual S3 bucket name
    apiGatewayUrl: "https://s3eg7kdaja.execute-api.ap-south-1.amazonaws.com/prod",
    razorpayKeyId: "rzp_live_TqawwTSUz6rvuH",
    senderEmail: "no-reply@eventpro24.online",
    supportEmail: "support@eventpro24.online"
};
