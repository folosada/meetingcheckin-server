const logger        = require('morgan'),
    cors            = require('cors'),
    http            = require('http'),
    express         = require('express'),
    bodyParser      = require('body-parser'),
    uuid            = require('uuid'),
    AWS             = require('aws-sdk'),
    fs              = require('fs'),
    base64          = require('base-64');


AWS.config.apiVersions = {
    rekognition: '2016-06-27',
    s3: '2006-03-01'
};

AWS.config.loadFromPath('./config.json');

const collectionId = 'meetingcheckin';
const faceMatchThreshold = 70; //Limiar de similaridade, usada para buscar as faces na collection
const bucketName = 'meetingcheckin';
const dirFile = 'C:\\Temp\\';

const S3 = new AWS.S3();
const rekognition = new AWS.Rekognition();
const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());

if (process.env.NODE_ENV === 'development') {
    app.use(express.logger('dev'));
    app.use(errorhandler());
}

const port = process.env.PORT || 3000;

app.get('/bucketExists/:name', (req, res) => {
    bucketExists(req.params.name).then(data => {
        res.status(200).send({        
            result: data === true ? 'S' : 'N'
        });
    });
});

app.post('/arduinoUpload', (req, res) => {
    buffer = new Buffer();
    offset = 0;    
    req.on('data', data => {
        if (data) {
            buffer.write(data.toString(), offset, data.toString().length(), 'binary');
            offset = data.toString().length();
        }
    });
    req.on('end', () => {
        const userId = 'validacao';
            putFaceToBucket({userId: userId, file: buffer}).then(result => {
                if (result) {
                    putFaceToCollection(userId);
                    res.writeHead(200, {'Content-Type': 'text/plain'});
                    res.end('ACCEPTED\n');
                } else {
                    res.writeHead(200, {'Content-Type': 'text/plain'});
                    res.end('REJECTED\n');
                }
            });
    });    
});

app.post('/putImageToBucket', (req, res) => {
    let result;
    req.on('data', body => {
        body = JSON.parse(body);
        let image = body.image;    
        let userId = body.userId;      
        let data = new Buffer(image.toString().substr(22), 'base64');
        putFaceToBucket({userId: userId, file: data}).then((data) => {                
            if (data) {
                result = {result: "Arquivo hospedado!"};
                putFaceToCollection(userId);
            } else {
                result = {result: "Não foi possível concluir o processo!"};                
            }
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(result));                              
        }, (reason) => {
            console.log(reason);
        });
    });    
});

app.post('/searchImage', (req, res) => {
    req.on('data', body => {
        body = JSON.parse(body);
        let image = new Buffer(body.image.toString().substr(22), 'base64');
        compareFaces(image).then(data => {
            if (data) {
                res.end(data);
            }
        })
    })
});

http.createServer(app).listen(port, function (err) {
  console.log('listening in http://localhost:' + port);
  createCollection();
});

function compareFaces(data) {
    var params = {
        CollectionId: collectionId,
        Image: {
          Bytes: data
          /*S3Object: {
            Bucket: bucketName,
            Name: face
          }*/
        },
        FaceMatchThreshold: faceMatchThreshold,
        MaxFaces: 1 //Quantidade de faces que será retornada
      };

      return rekognition.searchFacesByImage(params).promise().then(data => {
        if (data.FaceMatches) {
            var face = data.FaceMatches[0];
            console.log("Face encontrada: " + face.Face.ExternalImageId);
            console.log("Com semelhança de: " + face.Similarity)
            return face.Face.ExternalImageId;
        } else {
            console.log("Não foram encontradas faces")
        }
      }, error => {
        console.log("Erro ao buscar face: " + error.message);
      });
}

function putFaceToCollection(face) {
    var input = {
        CollectionId: collectionId,
        Image: {
            //Bytes: new Buffer(base64Img) <- usar este parâmetro caso queira indexar uma imagem em base64, tamanho máximo 5mb
            S3Object: {
                Bucket: bucketName,
                Name: face + ".jpg"
            }
        },
        DetectionAttributes: ["ALL"],
        ExternalImageId: face
    };

    rekognition.indexFaces(input).promise().then(data => {
        console.log("Face indexada com sucesso!")
        console.log(data);
    }, err => {
        console.log("Erro ao indexar face: " + err.message);
    });
}

/**
 * Cria uma coleção para armazenar as faces.
 * Caso ja exista uma coleção com este id retorna um erro.
 */
function createCollection() {
    rekognition.createCollection({CollectionId: collectionId}, (err, data) => {
        if (err) {
            console.log("Erro ao criar coleção: " + err.message);
        } else {
            console.log("Coleção criada com sucesso.")
            console.log(data);
        }
    });
}

function putFaceToBucket(param) {
    return S3.putObject({
        Bucket: bucketName,
        Key: param.userId + ".jpg",
        Body: param.file,
        ContentEncoding: 'binary',
        ContentType: 'image/jpg'
    }).promise().then(() => {
        return true;
    }, () => {
        return false;
    });
}

function bucketExists(name) {    
    return S3.listBuckets().promise().then(data => {        
        return data.Buckets.some((bucket => {
            return bucket.Name === name;
        }));                
    });    
}