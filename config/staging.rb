# Staging settings
server "nullsix.com", :app, :web, :db, primary: true
set :rvm_ruby_string, '1.9.3@nullsix-staging'
set :deploy_to, "/srv/www/#{domain}_staging"
