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
    userPoolId: "ap-south-1_2eW46CZhF",
    clientId: "tuarer46kraf0cmt1ub5cq465",
    identityPoolId: "ap-south-1:b98c8f08-2eb6-48a6-8bfe-e5466c5c9383",
    dynamoDBTableName: "EventProUsers",
    eventsTableName: "EventProEvents",
    ticketsTableName: "EventProTickets",
    paymentsTableName: "EventProPayments",
    checkinsTableName: "EventProCheckins",
    reviewsTableName: "EventProReviews",
    alertsTableName: "EventProAlerts",
    s3BucketName: "eventpro-images-208443589904",
    apiGatewayUrl: "https://g1hs9e6ckb.execute-api.ap-south-1.amazonaws.com/prod",
    razorpayKeyId: "rzp_live_TqawwTSUz6rvuH",
    senderEmail: "no-reply@eventpro24.online",
    supportEmail: "support@eventpro24.online"
};
