
import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
    scenarios: {
        flash_sale: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '10s', target: 50 },
                { duration: '10s', target: 100 },
                { duration: '5s', target: 0 },
            ],
            gracefulRampDown: '0s',
        },
    },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export function setup() {
    // Initialize stock to 100
    const payload = JSON.stringify({
        productId: 'iphone-15',
        quantity: 100
    });
    const headers = { 'Content-Type': 'application/json' };
    http.post(`${BASE_URL}/init`, payload, { headers });
}

export default function () {
    const payload = JSON.stringify({
        productId: 'iphone-15',
        userId: uuidv4(),
    });

    const params = {
        redirects: 0,
        headers: {
            'Content-Type': 'application/json',
            'x-idempotency-key': uuidv4(),
        },
    };

    const res = http.post(`${BASE_URL}/order`, payload, params);
    check(res, {
        'status is 200 or 409 or 302': (r) => r.status === 200 || r.status === 409 || r.status === 302,
    });
}
