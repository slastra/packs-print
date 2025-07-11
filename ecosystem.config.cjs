module.exports = {
  apps: [{
    name: 'packs-print',
    script: 'src/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }],

  deploy: {
    production: {
      user: process.env.DEPLOY_USER || 'shaun',
      host: process.env.DEPLOY_HOST || 'rp30',
      ref: 'origin/main',
      repo: process.env.DEPLOY_REPO || 'https://github.com/slastra/packs-print.git',
      path: process.env.DEPLOY_PATH || '/home/shaun/packs-print',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.cjs --env production',
      'pre-setup': ''
    }
  }
};