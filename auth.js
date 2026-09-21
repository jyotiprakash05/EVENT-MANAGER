(function () {
    const config = window.EVENTPRO_AWS_CONFIG;
    const sdk = window.AmazonCognitoIdentity;

    function showMessage(form, message, isError) {
        let element = form.querySelector("[data-auth-message]");
        if (!element) {
            element = document.createElement("p");
            element.dataset.authMessage = "true";
            form.appendChild(element);
        }
        element.textContent = message;
        element.style.color = isError ? "#b42318" : "#087443";
    }

    function isConfigured() {
        return config && sdk && config.userPoolId && !config.userPoolId.startsWith("YOUR_") && config.clientId && !config.clientId.startsWith("YOUR_");
    }

    function getPool() {
        return new sdk.CognitoUserPool({
            UserPoolId: config.userPoolId,
            ClientId: config.clientId
        });
    }

    function redirectForRole(role) {
        window.location.replace(role === "organizer"
            ? "Organizer_Dashboard/Event_list_organizer.html"
            : "Attendee_Dashboard/Event_List.html");
    }

    function attachSignUp() {
        const form = document.querySelector(".sign-up-form");
        const verifyForm = document.querySelector(".verify-form");
        if (!form) return;

        let pendingUsername = "";

        form.addEventListener("submit", function (event) {
            event.preventDefault();
            if (!isConfigured()) {
                showMessage(form, "Add your Cognito values to aws-config.js first.", true);
                return;
            }

            const role = form.querySelector("input[name='user-type']:checked").value;
            const attributes = [
                new sdk.CognitoUserAttribute({ Name: "email", Value: form.email.value }),
                new sdk.CognitoUserAttribute({ Name: "given_name", Value: form["first-name"].value }),
                new sdk.CognitoUserAttribute({ Name: "family_name", Value: form["last-name"].value }),
                new sdk.CognitoUserAttribute({ Name: "phone_number", Value: form.phone.value })
            ];

            pendingUsername = form.email.value;

            getPool().signUp(pendingUsername, form.password.value, attributes, null, function (error) {
                if (error) {
                    showMessage(form, error.message || "Unable to create your account.", true);
                    return;
                }
                sessionStorage.setItem("eventpro_pending_role", role);
                
                if (verifyForm) {
                    form.style.display = "none";
                    verifyForm.style.display = "block";
                    showMessage(verifyForm, "Account created. Check your email for the verification code.", false);
                } else {
                    showMessage(form, "Account created. Check your email to confirm it, then sign in.", false);
                }
                form.reset();
            });
        });

        if (verifyForm) {
            verifyForm.addEventListener("submit", function(event) {
                event.preventDefault();
                const code = verifyForm.code.value;
                
                const cognitoUser = new sdk.CognitoUser({
                    Username: pendingUsername,
                    Pool: getPool()
                });
                
                cognitoUser.confirmRegistration(code, true, function(err, result) {
                    if (err) {
                        showMessage(verifyForm, err.message || "Invalid verification code.", true);
                        return;
                    }
                    
                    showMessage(verifyForm, "Account verified! Redirecting to sign in...", false);
                    setTimeout(() => {
                        window.location.href = "SIGNIN.html";
                    }, 2000);
                });
            });
        }
    }

    function attachSignIn() {
        const form = document.querySelector(".sign-in-form");
        if (!form) return;

        form.addEventListener("submit", function (event) {
            event.preventDefault();
            if (!isConfigured()) {
                showMessage(form, "Add your Cognito values to aws-config.js first.", true);
                return;
            }

            const role = form.querySelector("input[name='user-type']:checked").value;
            const user = new sdk.CognitoUser({ Username: form.email.value, Pool: getPool() });
            const authentication = new sdk.AuthenticationDetails({
                Username: form.email.value,
                Password: form.password.value
            });

            user.authenticateUser(authentication, {
                onSuccess: function (session) {
                    const idToken = session.getIdToken().getJwtToken();
                    const payload = session.getIdToken().payload;
                    
                    if (window.AWS && config.identityPoolId && !config.identityPoolId.startsWith("YOUR_")) {
                        const logins = {};
                        logins[`cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`] = idToken;
                        
                        AWS.config.region = config.region;
                        AWS.config.credentials = new AWS.CognitoIdentityCredentials({
                            IdentityPoolId: config.identityPoolId,
                            Logins: logins
                        });

                        AWS.config.credentials.get(function(err) {
                            if (err) {
                                console.error("Error retrieving AWS identity:", err);
                                user.signOut();
                                showMessage(form, "AWS Identity Error: " + (err.message || "Could not retrieve credentials."), true);
                                return;
                            }
                            
                            if (config.dynamoDBTableName && !config.dynamoDBTableName.startsWith("YOUR_")) {
                                const docClient = new AWS.DynamoDB.DocumentClient();
                                
                                const getParams = {
                                    TableName: config.dynamoDBTableName,
                                    Key: { userId: payload.sub }
                                };
                                
                                docClient.get(getParams, function(err, data) {
                                    if (err) {
                                        console.error("Error fetching user from DynamoDB", err);
                                        user.signOut();
                                        showMessage(form, "Error verifying account.", true);
                                        return;
                                    }
                                    
                                    if (data && data.Item) {
                                        // Returning user! Check if the role matches
                                        if (data.Item.role !== role) {
                                            user.signOut();
                                            showMessage(form, "Your account is not assigned to that role.", true);
                                            return;
                                        }
                                        redirectForRole(role);
                                    } else {
                                        // First time login! Save the role.
                                        const putParams = {
                                            TableName: config.dynamoDBTableName,
                                            Item: {
                                                userId: payload.sub,
                                                email: payload.email,
                                                firstName: payload.given_name || "",
                                                lastName: payload.family_name || "",
                                                phone: payload.phone_number || "",
                                                role: role,
                                                lastLogin: new Date().toISOString()
                                            }
                                        };
                                        
                                        docClient.put(putParams, function(err, data) {
                                            if (err) {
                                                console.error("Unable to add user to DynamoDB", err);
                                                user.signOut();
                                                showMessage(form, "Error setting up your account.", true);
                                            } else {
                                                console.log("User successfully recorded in DynamoDB");
                                                redirectForRole(role);
                                            }
                                        });
                                    }
                                });
                            } else {
                                redirectForRole(role);
                            }
                        });
                    } else {
                        redirectForRole(role);
                    }
                },
                onFailure: function (error) {
                    showMessage(form, error.message || "Unable to sign in.", true);
                },
                newPasswordRequired: function () {
                    showMessage(form, "A new password is required for this account.", true);
                }
            });
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        attachSignUp();
        attachSignIn();
    });
}());
