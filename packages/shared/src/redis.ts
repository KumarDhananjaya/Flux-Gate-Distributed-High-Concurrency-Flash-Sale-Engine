
import Redis from 'ioredis';

export const redisClient = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
});

// Atomic decrement script
// KEYS[1]: stock key (e.g., "product:123:stock")
// ARGV[1]: quantity to decrement (e.g., 1)
// Returns 1 if successful, 0 if insufficient stock
const decrementStockScript = `
  local stockKey = KEYS[1]
  local qty = tonumber(ARGV[1])
  local current = tonumber(redis.call('get', stockKey) or "0")
  if current >= qty then
    redis.call('decrby', stockKey, qty)
    return 1
  else
    return 0
  end
`;

export const decrementStock = async (productId: string, quantity: number): Promise<boolean> => {
    const result = await redisClient.eval(decrementStockScript, 1, `product:${productId}:stock`, quantity.toString());
    return result === 1;
};

export const initStock = async (productId: string, quantity: number) => {
    await redisClient.set(`product:${productId}:stock`, quantity.toString());
}
