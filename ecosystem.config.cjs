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
      user: 'shaun',
      host: 'rp30',
      ref: 'origin/main',
      repo: 'https://github.com/slastra/packs-print.git',
      path: '/home/shaun/packs-print',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.cjs --env production'
    }
  }
};