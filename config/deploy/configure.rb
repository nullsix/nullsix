namespace :configure do

  # after deploy, this will link the database.yml
  task :link_database_yml do
    #puts "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!#{release_path}"
 #   run <<-CMD
#ln -nfs #{shared_path}/database.yml #{release_path}/config/database.yml
#CMD
  end

  # this will create shared directories for gems
  task :create_shared_directories do
    run <<-CMD
mkdir -p -m 777 #{shared_path}/gems &&
mkdir -p -m 777 #{shared_path}/gems/gems &&
mkdir -p -m 777 #{shared_path}/gems/specifications
CMD
  end
end

namespace :bundlr do
  task :redeploy_gems, :roles => :app, :except => {:no_release => true} do
    run %{
cd #{release_path} &&
ln -nfs #{shared_path}/gems/gems #{release_path}/gems/gems &&
ln -nfs #{shared_path}/gems/specifications #{release_path}/gems/specifications &&
thor merb:gem:redeploy
}
  end
end