require 'bundler/capistrano'

# Servers
#production
set :domain, 'kernelriot.com'
role :app, domain
role :web, domain
set :user, 'kernelRiot'
role :db, domain, :primary => true


# Application
set :application, "nullsix"
set :deploy_to, "/home/#{user}/#{domain}"

# Settings
set :use_sudo, false
#default_run_options[:pty] = true
set :keep_releases, 2
#set :chmod755, "app config db lib public vendor script script/* public/disp*"
ssh_options[:keys] = %w(~/.ssh/authorized_keys)
#ssh_options[:keys] = %w(/etc/ssh/ssh_host_rsa_key)

# Includes
load 'config/deploy/configure'

# Git
set :scm, :git
set :branch, 'master'
set :repository,  "#{user}@#{domain}:~/repos/#{application}.git"
set :deploy_via, :remote_cache
#set :scm_command, "~/packages/bin/git"
#set :local_scm_command, "/opt/local/bin/git"
#set :scm_verbose, true
set :git_shallow_clone, 1
set :git_enable_submodules, 1

#############################################################
# Post Deploy Hooks
#############################################################

namespace :deploy do

  desc "Runs after every successful deployment"
  task :after_default do
    cleanup #removes the old deploys
  end

  after "configure:link_database_yml", "configure:create_shared_directories"
  after "deploy:update_code", "configure:link_database_yml"
  after "deploy:symlink", "bundlr:redeploy_gems"
end

#############################################################
# Passenger
#############################################################

namespace :deploy do
  desc "Restarting mod_rails with restart.txt"
  task :restart, :roles => :app, :except => { :no_release => true } do
    run "touch #{current_path}/tmp/restart.txt"
  end

  [:start, :stop].each do |t|
    desc "#{t} task is a no-op with mod_rails"
    task t, :roles => :app do ; end
  end
end

# deploy config

#task :after_update_code, :roles => :app do
#  if ENV['build_gems'] and ENV['build_gems'] == '1'
#    run "rake -f #{release_path}/Rakefile gems:build"
#  end
#end

#role :web, "your web-server here"                          # Your HTTP server, Apache/etc
#role :app, "your app-server here"                          # This may be the same as your `Web` server
#role :db,  "your primary db-server here", :primary => true # This is where Rails migrations will run
#role :db,  "your slave db-server here"

# if you're still using the script/reaper helper you will need
# these http://github.com/rails/irs_process_scripts

## If you are using Passenger mod_rails uncomment this:
#namespace :deploy do
##  task :restart do
##    run "touch #{current_path}/tmp/restart.txt"
##  end
#  task :start do ; end
#  task :stop do ; end
#  task :restart, :roles => :app, :except => { :no_release => true } do
#    run "touch #{File.join(current_path,'tmp','restart.txt')}"
#  end
#end
