window.AdminBackend = (function() {
    let docClient;

    function init() {
        if (!AWS.config.credentials) {
            console.error("AWS credentials not set yet.");
            return false;
        }
        docClient = new AWS.DynamoDB.DocumentClient();
        return true;
    }

    return {
        getDashboardStats: function(callback) {
            if (!docClient && !init()) return callback(new Error("AWS not initialized"));

            let stats = {
                totalUsers: 0,
                organizers: 0,
                attendees: 0,
                platformRevenue: 0,
                usersList: []
            };

            const usersParams = {
                TableName: window.EVENTPRO_AWS_CONFIG.dynamoDBTableName
            };

            docClient.scan(usersParams, function(err, usersData) {
                if (err) return callback(err);

                const users = usersData.Items || [];
                stats.totalUsers = users.length;
                stats.usersList = users;

                users.forEach(u => {
                    if (u.userType === 'organizer') stats.organizers++;
                    else stats.attendees++;
                });

                const eventsParams = {
                    TableName: window.EVENTPRO_AWS_CONFIG.eventsTableName
                };

                docClient.scan(eventsParams, function(err, eventsData) {
                    if (err) return callback(err);

                    const events = eventsData.Items || [];
                    const PLATFORM_FEE_PERCENT = 0.005; // 0.5%
                    
                    let totalGross = 0;
                    events.forEach(e => {
                        const tickets = e.ticketsSold || 0;
                        const price = e.price || 0;
                        const rev = e.revenue || (tickets * price) || 0;
                        totalGross += rev;
                    });
                    
                    // The platform makes 0.5% of all gross sales + ₹20 one-time fee from organizers
                    stats.platformRevenue = (totalGross * PLATFORM_FEE_PERCENT) + (stats.organizers * 20);

                    callback(null, stats);
                });
            });
        },

        deleteUser: function(email, callback) {
            if (!docClient && !init()) return callback(new Error("AWS not initialized"));
            
            const params = {
                TableName: window.EVENTPRO_AWS_CONFIG.dynamoDBTableName,
                Key: { email: email }
            };

            docClient.delete(params, function(err) {
                if (err) callback(err);
                else callback(null);
            });
        }
    };
})();
