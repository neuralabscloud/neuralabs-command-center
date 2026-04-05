[Unit]
Description=Trading Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory={{INSTALL_DIR}}/trading-dashboard
ExecStart=/usr/bin/node server.js
EnvironmentFile={{INSTALL_DIR}}/.env
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
