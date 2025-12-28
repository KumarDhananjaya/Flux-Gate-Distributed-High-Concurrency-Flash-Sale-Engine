
import Fastify from 'fastify';
import path from 'path';
import fastifyStatic from '@fastify/static';

const fastify = Fastify({ logger: true });

fastify.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
    prefix: '/', // optional: default '/'
});

fastify.get('/', async (req, reply) => {
    return (reply as any).sendFile('index.html');
});

const start = async () => {
    try {
        await fastify.listen({ port: 4000, host: '0.0.0.0' });
        console.log('Waiting Room running on port 4000');
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
