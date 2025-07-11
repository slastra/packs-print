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
      user: 'pi',
      host: 'rp30',
      ref: 'origin/main',
      repo: 'git@github.com:yourusername/packs-print.git', // Update this
      path: '/home/pi/packs-print',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
      'pre-setup': ''
    }
  }
};