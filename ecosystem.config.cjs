module.exports = {
  apps: [{
    name: 'foxform',
    script: 'dist/index.cjs',
    cwd: '/home/formprox/foxform',
    env: {
      NODE_ENV: 'production',
      PORT: 5000,
      DATABASE_URL: 'postgresql://neondb_owner:npg_IOA6FeG9UoXp@ep-rapid-dust-a19ntx9z-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
      JWT_SECRET: 'proxyform_jwt_secret_2026_secure_key',
      ADMIN_EMAIL: 'admin@proxyform.com',
      ADMIN_PASSWORD: 'Admin@123'
    },
    instances: 1,
    max_memory_restart: '1G',
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
