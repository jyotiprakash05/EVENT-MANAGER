(function () {
    const config = window.EVENTPRO_AWS_CONFIG;
    const sdk = window.AmazonCognitoIdentity;
    const requiredRole = document.body.dataset.requiredRole;

    if (!requiredRole || !config || !sdk || (config.userPoolId && config.userPoolId.startsWith("YOUR_")) || (config.clientId && config.clientId.startsWith("YOUR_"))) {
        return;
    }

    const pool = new sdk.CognitoUserPool({
        UserPoolId: config.userPoolId,
        ClientId: config.clientId
    });
    const user = pool.getCurrentUser();

    if (!user) {
        window.location.replace("../SIGNIN.html");
        return;
    }

    user.getSession(function (error, session) {
        if (error || !session || !session.isValid()) {
            window.location.replace("../SIGNIN.html");
            return;
        }
        
        // At this point they are authenticated. 
        // Strict role validation is handled during SIGNIN.html via DynamoDB.
        
        // Update the dashboard UI with the user's real name
        const payload = session.getIdToken().payload;
        const firstName = payload.given_name || "User";
        const initial = firstName.charAt(0).toUpperCase();

        const avatars = document.querySelectorAll(".user-avatar");
        avatars.forEach(el => el.textContent = initial);

        const nameSpans = document.querySelectorAll(".user-pill span:not(.user-avatar)");
        nameSpans.forEach(el => el.textContent = firstName);
    });
}());
