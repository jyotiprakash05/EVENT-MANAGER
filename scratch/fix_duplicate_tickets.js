const fs = require('fs');
const path = require('path');

// 1. Update attendee-backend.js
const backendPath = path.join(__dirname, '../Attendee_Dashboard/attendee-backend.js');
let backend = fs.readFileSync(backendPath, 'utf8');

// Ensure updateSplitPayment does NOT assign the sub-ticket to the original buyer's attendeeId
const oldAttendeeAssign = 'attendeeId: currentUserSub || t.attendeeId,';
const newAttendeeAssign = 'attendeeId: (currentUserSub && currentUserSub !== t.attendeeId) ? currentUserSub : `guest_${memberTicketId}`,';

if (backend.includes(oldAttendeeAssign)) {
    backend = backend.replace(oldAttendeeAssign, newAttendeeAssign);
    fs.writeFileSync(backendPath, backend, 'utf8');
    console.log('Fixed attendee-backend.js: sub-ticket now assigned to guest instead of original buyer');
}

// 2. Update Your_Booking.html
const yourBookingPath = path.join(__dirname, '../Attendee_Dashboard/Your_Booking.html');
let yourBooking = fs.readFileSync(yourBookingPath, 'utf8');

// Filter at the very start of getMyBookings callback
const oldCallbackStart = `window.AttendeeBackend.getMyBookings(function(err, tickets) {
                        const list = document.getElementById('bookingList');`;

const newCallbackStart = `window.AttendeeBackend.getMyBookings(function(err, rawTickets) {
                        const list = document.getElementById('bookingList');
                        if (err) {
                            list.innerHTML = '<p style="color: #ef4444; padding: 20px;">Error loading bookings: ' + err.message + '</p>';
                            return;
                        }

                        // Filter out child sub-tickets of parent group tickets owned by this user
                        const parentGroupIds = new Set((rawTickets || []).filter(t => t.isGroupSplit).map(t => t.ticketId));
                        let tickets = (rawTickets || []).filter(t => {
                            // If this ticket is a friend's sub-ticket belonging to one of the user's parent bookings, do not show it as a separate pass
                            if (t.isGroupSplitMember && t.parentTicketId && parentGroupIds.has(t.parentTicketId)) {
                                return false;
                            }
                            return true;
                        });`;

if (yourBooking.includes('window.AttendeeBackend.getMyBookings(function(err, tickets) {')) {
    const idx = yourBooking.indexOf('window.AttendeeBackend.getMyBookings(function(err, tickets) {');
    const endBlock = yourBooking.indexOf('if (!tickets || tickets.length === 0) {', idx);
    if (idx !== -1 && endBlock !== -1) {
        yourBooking = yourBooking.slice(0, idx) + newCallbackStart + '\n\n                        ' + yourBooking.slice(endBlock);
        fs.writeFileSync(yourBookingPath, yourBooking, 'utf8');
        console.log('Fixed Your_Booking.html: filtered friend sub-tickets from buyer booking list');
    }
}

// Also remove cached friend passes from local storage in Your_Booking.html if the user is the group owner
console.log('Completed logic update');

